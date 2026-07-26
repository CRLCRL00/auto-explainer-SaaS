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
 */
export async function callLlm(opts: {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  const cfg = await resolveConfig({ model: opts.model });
  const { logger } = await import('./logger');

  if (cfg.provider === 'anthropic') {
    return callAnthropic(cfg, opts, logger);
  }
  if (cfg.provider === 'minimax') {
    // MiniMax 不走 OpenAI SDK 包装：用户决策 (commit 后 notes)。MiniMax-M3 的 chat 实际是
    // /v1/text/chatcompletion_v2 路径，OpenAI SDK 会拼 /v1/chat/completions → 路径错。
    // 直接 fetch 到 MiniMax 自己的 endpoint，body 用 OpenAI-style messages。
    return callMinimax(cfg, opts, logger);
  }
  return callOpenAICompat(cfg, opts, logger);
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