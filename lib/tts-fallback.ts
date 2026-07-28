// v0.6.1 TTS auto-downgrade wrapper (spec §4.3 second-chunk — TTS 段).
//
// 模式上与 lib/llm-fallback.ts:withAnthropicFallback 同源:
//   - caller 传 synthesizeAzure / synthesizeEdge 两个 callback
//   - azure 抛错 → isInfrastructureError(err) + 配齐 edge 时 → 调 edge
//   - 4xx logic / 缺 edge env → rethrow 原 azure 错 (no silent fallback)
//
// 区别于 llm-fallback:
//   - TTS 不像 LLM 那样 '5xx vs 4xx logic 区分' 严格 — Azure SDK 大多错是
//     network / quota / 401 auth 等, 没有清晰的 'logic vs infra' 分界.
//   - 这里宽松: 任何 Azure 错都试 fallback (除了 'env 未配' / 'voice 不支持
//     这种纯 config 错'). 简化 caller 决策.
//
// 注意 — 这里 isInfrastructureError 是宽松版 (任何非配置错都 fallback). 真
// '是不是 infra 错' 是误判很多 — 我们靠 retry helper + retry budget 兜底,
// 不在这里分.

import { logger } from './logger';

export interface TTSFallbackOpts {
  text: string;
  voice?: string;
  outputFormat?: 'mp3' | 'wav';
}

/**
 * 区分 'config 错' (透传) vs '可能 infra 错 (尝试 fallback)'.
 *
 * 配置错 (不 fallback):
 *   - 'AZURE_SPEECH_KEY / AZURE_SPEECH_REGION not configured' (env 缺)
 *   - 'voice ... not supported'
 *   - 'subscription key ... invalid' (401 — 这是 key 配置错, 不 fallback)
 *
 * 其他 (fallback):
 *   - '5xx internal server error' / quota / region outage / network 等
 *
 * 简化策略: 含 'not configured' / 'invalid' / 'not supported' 等关键词的错透传;
 * 其他 fallback.
 */
export function isAzureConfigError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /not configured|invalid|not supported|unauthorized|forbidden/i.test(msg);
}

export async function withTtsFallback(
  opts: TTSFallbackOpts,
  callAzure: () => Promise<ArrayBuffer>,
  callEdge: () => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  try {
    return await callAzure();
  } catch (err: unknown) {
    // 配置错 (env 缺 / key 无效) 透传 — 不静默 fallback
    if (isAzureConfigError(err)) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'azure TTS config error; passing through (no edge fallback for config issues)',
      );
      throw err;
    }
    // 其他 (5xx / quota / region outage / network) — fallback
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), fallback: 'edge-tts' },
      'azure TTS infra error; falling back to Edge TTS',
    );
    return await callEdge();
  }
}
