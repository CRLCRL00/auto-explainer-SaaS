// v0.5.2 LLM auto-downgrade (spec §4.3 second-chunk).
//
// 现状: dispatch 是用户-configured 单 provider (anthropic / openai-compatible / minimax).
//   失败 → 异常抛出 → phase 撞墙。
//
// 新: anthropic 5xx / timeout / network error → 自动切 openai-compatible (GPT-4o 默认).
//   第二次异常 → 撞墙，retry helper 接住。
//
// IMPORTANT: minimax 路径的 OpenRouter fallback 已存在 (callMinimaxWithFallback);
// 这里是 anthropic 路径的 GPT-4o fallback. 两条互不干扰.
//
// surface:
//   - withAnthropicFallback(opts): 包 anthropic 调用, infra-err 自动切 GPT-4o.
//   - isInfrastructureError(err): 判 5xx / network / timeout.
//   - isOpenAIFallbackAvailable(): 判 env 配齐 (OPENAI_API_KEY).

import { getEnv } from './env';
import { logger } from './logger';

/** 基础 LLM 调用参数 — 与 lib/llm.ts 的 opts 类型一致 (avoid coupling) */
export interface LLMCallOpts {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  maxTokens?: number;
  model?: string;
}

export interface LLMFallbackResult {
  /** 真实使用 provider (handy for audit log) */
  provider: 'anthropic' | 'openai-compatible';
  /** 原始调用函数 — caller 传入具体 SDK impl */
  call: (opts: LLMCallOpts) => Promise<string>;
}

/**
 * 判断 error 是否 'infra' (5xx / timeout / network), 区别于 'logic' (4xx / schema).
 * logic error 立刻撞墙; infra 才走 fallback.
 */
export function isInfrastructureError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    // string / object error messages
    if (typeof err === 'object' && err !== null) {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string') return classifyErrorMessage(m);
    }
    return false;
  }
  return classifyErrorMessage(err.message);
}

function classifyErrorMessage(msg: string): boolean {
  // patterns typical of infra failure (5xx upstream, timeout, network, DNS, rate-limit at proxy)
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|fetch failed|getaddrinfo|network|socket hang up|server overloaded|5\d\d|429|internal server error|bad gateway|service unavailable|gateway timeout/i.test(msg);
}

/** 检查 env 是否有 OpenAI key (兼容 OPENAI_BASE_URL override) */
export function isOpenAIFallbackAvailable(): boolean {
  const env = getEnv();
  return Boolean(env.OPENAI_API_KEY);
}

/**
 * 包装 anthropic 调用 — 失败且是 infra error + OpenAI key 齐 → 自动切 GPT-4o.
 * 调用方提供 callAnthropic 函数, 我们不直接 import Anthropic SDK (避免循环依赖).
 */
export async function withAnthropicFallback(
  opts: LLMCallOpts,
  callAnthropic: () => Promise<string>,
  callOpenAI: () => Promise<string>,
): Promise<string> {
  try {
    return await callAnthropic();
  } catch (err) {
    if (!isInfrastructureError(err)) {
      // 4xx / schema 等'logic' error 立即透传, 不 retry 不 fallback.
      throw err;
    }
    if (!isOpenAIFallbackAvailable()) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), fallback: 'openai' },
        'anthropic infra error but OPENAI_API_KEY not configured — passing through to wall',
      );
      throw err;
    }
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), fallback: 'openai-compatible' },
      'anthropic infra error → falling back to GPT-4o (openai-compatible)',
    );
    return await callOpenAI();
  }
}
