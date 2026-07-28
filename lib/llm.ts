// LLM client factory + unified callLlm() that dispatches by provider.
//
// v0.0.1 alpha: provider = 'anthropic' | 'openai-compatible'
//   - anthropic → @anthropic-ai/sdk (existing path; backwards compatible)
//   - openai-compatible → openai SDK with optional baseURL
//     (DeepSeek / DashScope / 通义千问 / OpenRouter / Ollama / vLLM ... 都用 OpenAI-compatible 协议)
//
// 旧 API (getAnthropic / callClaude) 保留作为 Task 14/15 还在用的 thin wrapper，
// 内部 delegate 到新 callLlm()。
//
// 模型名优先级：opts.model ?? settings.model ?? DEFAULT_MODEL (provider-specific)
// apiKey 优先级：settings.apiKey ?? getEnv().ANTHROPIC_API_KEY (仅 anthropic 时 env fallback)
// baseURL 优先级：settings.baseURL ?? undefined (留空 → 用 provider 默认)
//
// 实时生效：每次调用 readLlmSettings()（与之前 /settings 改 key 立即生效策略一致）

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getEnv } from './env';
import { withAnthropicFallback } from './llm-fallback';
import { cachedPlan, cachedScript, detectLlmRole } from './llm-offline';

// P2 OpenRouter fallback: in-memory sliding window for fallback rate limiting.
// 进程内有效；HMR restart 会 reset state.
const FALLBACK_WINDOW_MS = 60_000;
const FALLBACK_MAX_RECENT = 5;
const fallbackRecent: number[] = [];

const DEFAULT_MODEL_ANTHROPIC = 'claude-sonnet-4-5';
const DEFAULT_MODEL_OPENAI_COMPAT = 'gpt-4o-mini'; // OpenAI-compatible 端点的常用 default

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ResolvedLlmConfig {
  provider: 'anthropic' | 'openai-compatible' | 'minimax';
  model: string;
  apiKey: string;
  baseURL?: string;
}

async function resolveConfig(opts: { model?: string }): Promise<ResolvedLlmConfig> {
  const { readLlmSettings, DEFAULT_PROVIDER, PROVIDER_DEFAULT_BASEURL } = await import('./llm-settings');
  const settings = await readLlmSettings();
  const provider = settings?.provider ?? DEFAULT_PROVIDER;
  const defaultModel =
    provider === 'anthropic' ? DEFAULT_MODEL_ANTHROPIC : DEFAULT_MODEL_OPENAI_COMPAT;
  const model = opts.model ?? settings?.model ?? defaultModel;

  if (provider === 'anthropic') {
    const apiKey = settings?.apiKey ?? getEnv().ANTHROPIC_API_KEY;
    return { provider, model, apiKey };
  }
  // openai-compatible / minimax: apiKey 必填。空值直接抛 clear error，避开 3 次 retry loop (~7s)。
  const apiKey = settings?.apiKey ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      `missing apiKey for ${provider} provider — paste an API key via /settings`,
    );
  }
  // baseURL 优先级：用户显式填 > provider 默认 (minimax 有官方默认 endpoint)
  const baseURL = settings?.baseURL ?? PROVIDER_DEFAULT_BASEURL[provider] ?? undefined;
  return { provider, model, apiKey, baseURL };
}

// ─────────────────────────────────────────────────────────────────
// 新 API：provider dispatch
// ─────────────────────────────────────────────────────────────────

/**
 * 构造一个 LLM 客户端 (Anthropic 或 OpenAI SDK instance)。
 * 注意返回类型是 union — caller 通常应该用 callLlm() 而不是直接用客户端。
 */
export type LlmClient =
  | { provider: 'anthropic'; client: Anthropic }
  | { provider: 'openai-compatible'; client: OpenAI }
  | { provider: 'minimax'; client: OpenAI };

export async function getLlmClient(opts: { model?: string } = {}): Promise<LlmClient> {
  const cfg = await resolveConfig(opts);
  if (cfg.provider === 'anthropic') {
    return { provider: 'anthropic', client: new Anthropic({ apiKey: cfg.apiKey }) };
  }
  // minimax 走 OpenAI SDK 兼容 (与 openai-compatible 同 SDK 不同 provider label)
  return {
    provider: cfg.provider,
    client: new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }),
  };
}

/**
 * 统一 LLM 调用：内部按 provider dispatch 到对应 SDK。
 * 返回 assistant 文本（不解析 JSON — caller 用 parseAssistantJson 自己做）。
 *
 * v0.6.1 R5: spec §4.3 LLM offline mode. 主路径 + fallback 全 fail → cached
 * template 输出 (deterministic, 5-beat 模板). 不让 LLM provider 完全 down 时
 * pipeline 100% fail.
 */
export async function callLlm(opts: {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  const cfg = await resolveConfig({ model: opts.model });
  const { logger } = await import('./logger');

  // 从 messages 提取 topic (user prompt 的第一段, 通常含 topic 字面)
  const topic = extractTopic(opts.messages);

  try {
    if (cfg.provider === 'anthropic') {
      return await withAnthropicFallback(
        opts,
        () => callAnthropic(cfg, opts, logger),
        () => callOpenAIFallback(cfg, opts, logger),
      );
    }
    if (cfg.provider === 'minimax') {
      return await callMinimaxWithFallback(cfg, opts, logger);
    }
    return await callOpenAICompat(cfg, opts, logger);
  } catch (lastErr) {
    // v0.6.1 R5: spec §4.3 LLM offline mode (opt-in via env LLM_OFFLINE_FALLBACK=1).
    //
    // 默认 '0' = 强 throw 行为不变 — 'silent fallback' 是 UX 拐点 (用户不
    // 知道 LLM 真 down). opt-in 开启后, all providers fail → log warn + 用
    // 5-beat cached template 输出.
    const env = getEnv();
    if (env.LLM_OFFLINE_FALLBACK !== '1') {
      throw lastErr;
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    const role = detectLlmRole(opts.system);
    logger.warn(
      { err: msg, topic, role, fallback: 'cached-template' },
      'all LLM providers failed (LLM_OFFLINE_FALLBACK=1); using cached template (spec §4.3)',
    );
    if (role === 'script') {
      return cachedScript(topic, topic);
    }
    return cachedPlan(topic);
  }
}

/** 从 messages 提取 topic (user 消息首条拼接, fallback 'Auto-Explainer'). */
function extractTopic(messages: LlmMessage[]): string {
  const userMsg = messages.find((m) => m.role === 'user');
  return userMsg ? userMsg.content.slice(0, 200) : 'Auto-Explainer';
}

async function callAnthropic(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.apiKey });
  const params: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: opts.maxTokens ?? 4096,
    messages: opts.messages,
  };
  if (opts.system) params.system = opts.system;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.messages.create(params as never);
      const block = res.content[0];
      if (block.type !== 'text') throw new Error('non-text response');
      return block.text;
    } catch (err: unknown) {
      lastErr = err;
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: unknown }).status
          : undefined;
      if (status && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 16000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'anthropic retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * v0.6.1: GPT-4o fallback (被 withAnthropicFallback 调用)
 *
 * Not for direct invocation. withAnthropicFallback 的 wrapper 已 check:
 *   - err 是不是 infra (5xx/timeout/429)
 *   - env.OPENAI_API_KEY non-empty
 * 因此函数假设 apiKey 已配 + callOpenAIClient 能建. 配空 OPENAI_API_KEY 时
 * wrapper 自己 re-throw, 不到这里.
 *
 * 用 OPENAI 直连, baseURL 默认 `https://api.openai.com/v1` (官方). 暂不开放
 * override — 想用 DeepSeek / 通义 等 openai-compatible 替代 OpenAI 的, 走
 * 切 provider 路径 (在 settings page 选 openai-compatible + baseURL).
 *
 * Model 硬编码 `gpt-4o` — spec §4.3 决策. 不从 cfg.model 借 (那是 anthropic 的).
 */
async function callOpenAIFallback(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const env = getEnv();
  if (!env.OPENAI_API_KEY) {
    // 与 withAnthropicFallback 守卫一致 (应已提前 throw). 防御性:
    throw new Error('OPENAI_API_KEY not set — fallback unavailable');
  }
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push(m);

  let lastErr: unknown;
  // withAnthropicFallback wrapper 只调这里一次. 这里再做 2-次 retry 给
  // transient OpenAI 端 5xx 一个缓冲 (与 callAnthropic 内部 retry 精神
  // 一致 — 但限制次数, 不无限).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: 'gpt-4o',
        max_tokens: opts.maxTokens ?? 4096,
        messages,
      });
      const choice = res.choices[0];
      if (!choice?.message?.content) throw new Error('empty completion');
      return choice.message.content;
    } catch (err: unknown) {
      lastErr = err;
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: unknown }).status
          : undefined;
      if (status && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 4000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'openai-fallback retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

async function callOpenAICompat(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL });
  // OpenAI-compatible: messages 直接传，system 是 user-role 'system' content。
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push(m);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model: cfg.model,
        max_tokens: opts.maxTokens ?? 4096,
        messages,
      });
      const choice = res.choices[0];
      if (!choice?.message?.content) throw new Error('empty completion');
      return choice.message.content;
    } catch (err: unknown) {
      lastErr = err;
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: unknown }).status
          : undefined;
      if (status && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 16000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'openai-compat retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// ─────────────────────────────────
// 旧 API (back-compat for Task 14/15)：delegate 到 callLlm()
// ─────────────────────────────────

/**
 * MiniMax-M3 chat 调用：直接 fetch 到 /v1/text/chatcompletion_v2。
 *
 * 为什么不用 OpenAI SDK：MiniMax-M3 不接受 OpenAI 标准 /v1/chat/completions 路径
 * （probe 验证：OpenAI 路径返 402 但 base_resp 不含 1008 业务码）；
 * MiniMax 自有 path /v1/text/chatcompletion_v2 接受 OpenAI-style body + 返回 base_resp 业务码。
 *
 * body 用 { model, messages: [{role, content}], max_tokens } (OpenAI 兼容)，
 * auth 用 Authorization: Bearer ${apiKey} (MiniMax 官方 docs 验证)。
 */
async function callMinimax(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push(m);

  // baseURL = 'https://api.minimaxi.com/v1'（来自 settings；PROVIDER_DEFAULT_BASEURL fallback）
  const baseURL = cfg.baseURL ?? 'https://api.minimaxi.com/v1';
  const url = `${baseURL.replace(/\/+$/, '')}/text/chatcompletion_v2`;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_tokens: opts.maxTokens ?? 4096,
        }),
      });
      const text = await res.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { body = text; }
      // MiniMax 业务码：HTTP 200 但 base_resp.status_code != 0 也是错误
      // 1008 = insufficient balance, 2013 = invalid params 等
      const baseResp = (body as { base_resp?: { status_code?: number; status_msg?: string } } | null)?.base_resp;
      const businessCode = baseResp?.status_code ?? 0;
      const businessMsg = baseResp?.status_msg ?? '';
      if (businessCode !== 0) {
        // 业务错（HTTP 200 + base_resp 业务码）— 4xx 类立即抛错不 retry
        if (businessCode >= 4000 && businessCode < 5000) {
          throw new Error(`minimax ${businessCode} ${businessMsg}`);
        }
        // 1008/2013 等业务码也属失败 → 立即抛
        throw new Error(`minimax ${businessCode} ${businessMsg}`);
      }
      if (!res.ok) {
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw new Error(`minimax ${res.status}: ${text.slice(0, 200)}`);
        }
        throw new Error(`minimax ${res.status}: ${text.slice(0, 200)}`);
      }
      // success — parse MiniMax response (OpenAI-style choices + base_resp)
      const parsed = body as { choices?: Array<{ message?: { content?: string } }> };
      const content = parsed.choices?.[0]?.message?.content;
      if (!content) throw new Error('minimax empty completion');
      return content;
    } catch (err: unknown) {
      lastErr = err;
      const status = err instanceof Error && /minimax (\d{3})/.exec(err.message)
        ? Number(/minimax (\d{3})/.exec(err.message)![1])
        : undefined;
      if (status && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 16000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'minimax retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/**
 * P2 defensive wrapper: 当 callMinimax 抛出不可重试错误 (HTTP 4xx 或 base_resp 业务码 ≥ 4000)
 * 时，自动切换到 OpenRouter 走 minimax 模型 (或 OPENROUTER_FALLBACK_MODEL 配置的备用)。
 *
 * 触发条件 (详见 plan doc §7.1):
 *   - OPENROUTER_API_KEY 未配 → 透传原 error (不启用 fallback)
 *   - callMinimax 成功 → 直接返回 (不触发)
 *   - HTTP 4xx (除 429) → 切换
 *   - base_resp 业务码 ≥ 4000 且 < 5000 → 切换
 *   - 频率计数: 连续 fallback 触发 ≥ FALLBACK_MAX_RECENT 次 / FALLBACK_WINDOW_MS 窗口 → fast-fail
 *
 * 不污染 llm-settings.json：fallback 完全基于环境变量，与 user 配置解耦。
 *
 * ⚠️ plan §7.1 严格把 fallback 限定到 4xx HTTP + 4xxx 业务码；1008 / 2013 等业务码虽不可重试，
 * 但**不会**触发 fallback (按 plan)。如需扩展成"所有不可 retry 错误都 fallback"，未来 1 个 PR。
 */
async function callMinimaxWithFallback(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
): Promise<string> {
  const env = getEnv();
  // 清理窗口外时间戳
  const now = Date.now();
  while (fallbackRecent.length > 0 && fallbackRecent[0] < now - FALLBACK_WINDOW_MS) {
    fallbackRecent.shift();
  }
  // 频率计数 fast-fail
  if (fallbackRecent.length >= FALLBACK_MAX_RECENT) {
    throw new Error('openrouter fallback rate-limit exceeded; refusing to attempt');
  }

  try {
    return await callMinimax(cfg, opts, logger);
  } catch (err: unknown) {
    // 未配 key → 透传原 error
    if (!env.OPENROUTER_API_KEY) throw err;

    // 错误分类: 用 : 区分 HTTP 状态码 (minimax 4xx: text), 空格区分业务码 (minimax 4xxx msg)
    // —— 避免 4xxx 业务码被 (\d{3}) 误匹配为 HTTP 状态码
    const message = err instanceof Error ? err.message : String(err);
    const httpMatch = /minimax (\d{3}):/.exec(message);
    const bizMatch = /minimax (\d{4}) /.exec(message);
    const httpStatus = httpMatch ? Number(httpMatch[1]) : undefined;
    const businessCode = bizMatch ? Number(bizMatch[1]) : undefined;

    const shouldFallback =
      (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 429) ||
      (businessCode !== undefined && businessCode >= 4000 && businessCode < 5000);

    if (!shouldFallback) throw err;

    // 触发 fallback：记录窗口 + 调 OpenRouter
    fallbackRecent.push(now);
    logger.warn(
      { from: 'minimax', to: 'openrouter', err: message, windowSize: fallbackRecent.length },
      'llm fallback to openrouter',
    );
    return callOpenRouter(cfg, opts, logger, env);
  }
}

/**
 * P2: 通过 OpenAI SDK 调 OpenRouter (OpenAI 兼容协议，但走 OpenRouter 自家的 baseURL)。
 * 1 次 retry (minimax 路径已经 retry 3 次，叠加太重)。
 */
async function callOpenRouter(
  cfg: ResolvedLlmConfig,
  opts: { system?: string; messages: LlmMessage[]; maxTokens?: number },
  logger: { warn: (obj: object, msg: string) => void },
  env: { OPENROUTER_API_KEY?: string; OPENROUTER_BASE_URL?: string; OPENROUTER_FALLBACK_MODEL?: string },
): Promise<string> {
  const apiKey = env.OPENROUTER_API_KEY!; // 已被 callMinimaxWithFallback 守卫
  const baseURL = env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const model = env.OPENROUTER_FALLBACK_MODEL ?? cfg.model;

  const client = new OpenAI({ apiKey, baseURL });
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const m of opts.messages) messages.push(m);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await client.chat.completions.create({
        model,
        max_tokens: opts.maxTokens ?? 4096,
        messages,
      });
      const choice = res.choices[0];
      if (!choice?.message?.content) throw new Error('empty completion');
      return choice.message.content;
    } catch (err: unknown) {
      lastErr = err;
      const status = err && typeof err === 'object' && 'status' in err
        ? (err as { status: unknown }).status
        : undefined;
      if (status && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 4000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'openrouter retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

/** @deprecated Use getLlmClient() instead — kept for back-compat. */
export async function getAnthropic(): Promise<Anthropic> {
  const res = await getLlmClient();
  if (res.provider !== 'anthropic') {
    throw new Error('getAnthropic() called but provider is openai-compatible; use getLlmClient()');
  }
  return res.client;
}

/** @deprecated Use callLlm() instead — kept for back-compat. */
export async function callClaude(opts: {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  return callLlm(opts);
}

// 从 LLM 文本里抠 JSON（容忍 ```json fence / 前置废话）— 通用，与 provider 无关。
export function parseAssistantJson(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    return JSON.parse(trimmed.slice(start));
  }
  throw new Error('No JSON found');
}