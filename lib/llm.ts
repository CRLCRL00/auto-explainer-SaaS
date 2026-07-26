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
  provider: 'anthropic' | 'openai-compatible';
  model: string;
  apiKey: string;
  baseURL?: string;
}

async function resolveConfig(opts: { model?: string }): Promise<ResolvedLlmConfig> {
  const { readLlmSettings, DEFAULT_PROVIDER } = await import('./llm-settings');
  const settings = await readLlmSettings();
  const provider = settings?.provider ?? DEFAULT_PROVIDER;
  const defaultModel =
    provider === 'anthropic' ? DEFAULT_MODEL_ANTHROPIC : DEFAULT_MODEL_OPENAI_COMPAT;
  const model = opts.model ?? settings?.model ?? defaultModel;

  if (provider === 'anthropic') {
    const apiKey = settings?.apiKey ?? getEnv().ANTHROPIC_API_KEY;
    return { provider, model, apiKey };
  }
  // openai-compatible: apiKey 必填（否则 OpenAI SDK 会抛 'missing api key'）。
  // baseURL 留空 → SDK 默认 https://api.openai.com/v1。
  const apiKey = settings?.apiKey ?? '';
  const baseURL = settings?.baseURL ?? undefined;
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
  | { provider: 'openai-compatible'; client: OpenAI };

export async function getLlmClient(opts: { model?: string } = {}): Promise<LlmClient> {
  const cfg = await resolveConfig(opts);
  if (cfg.provider === 'anthropic') {
    return { provider: 'anthropic', client: new Anthropic({ apiKey: cfg.apiKey }) };
  }
  return {
    provider: 'openai-compatible',
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

/** @deprecated Use getLlmClient() instead — kept for back-compat. */
export async function getAnthropic(): Promise<Anthropic> {
  const { getLlmClient } = await import('./llm');
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