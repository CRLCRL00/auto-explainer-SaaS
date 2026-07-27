// Trigger.dev v4 SDK wrapper (P1 PR1: 引入基础设施, 不切流).
//
// PR1 设计：仅提供 lazy client factory + 同步 API surface，
// 不替换 lib/queue.ts (BullMQ 仍 active)。`getTriggerClient()` 是占位入口，
// 真正切流要到 PR3 (RUN_TRIGGER_DEV=1 + worker/index.ts 改写) 才被调用。
//
// HMR-safe: 用 globalThis 缓存 SDK module，避免 Next.js Fast Refresh 重复加载。

import { getEnv } from './env';

const g = globalThis as unknown as {
  __triggerSdk?: unknown; // dynamic import('@trigger.dev/sdk') 缓存
};

export interface TriggerConfig {
  projectRef: string;
  secretKey: string;
  apiUrl: string;
  deployment: 'self-hosted' | 'cloud';
}

/**
 * 提取并校验 Trigger.dev 所需的 env vars (RUN_TRIGGER_DEV 开启时才可用)。
 * 如果 flag 关或关键 env 缺失, throws clear error 以便 debug.
 */
export function resolveTriggerConfig(): TriggerConfig {
  const env = getEnv();
  if (env.RUN_TRIGGER_DEV !== '1') {
    throw new Error(
      '[Trigger.dev] RUN_TRIGGER_DEV=0 (default); set RUN_TRIGGER_DEV=1 in .env.local to opt in (切流仍未发生 — 仅 SDK wrapper available)',
    );
  }
  if (!env.TRIGGER_PROJECT_REF) {
    throw new Error('[Trigger.dev] TRIGGER_PROJECT_REF not set');
  }
  if (!env.TRIGGER_SECRET_KEY || env.TRIGGER_SECRET_KEY.length < 10) {
    throw new Error('[Trigger.dev] TRIGGER_SECRET_KEY missing or too short (min 10 chars)');
  }
  if (!env.TRIGGER_API_URL) {
    throw new Error('[Trigger.dev] TRIGGER_API_URL not set (e.g. http://trigger-web:3030)');
  }
  return {
    projectRef: env.TRIGGER_PROJECT_REF,
    secretKey: env.TRIGGER_SECRET_KEY,
    apiUrl: env.TRIGGER_API_URL,
    deployment: env.TRIGGER_DEPLOYMENT,
  };
}

/**
 * 异步加载 Trigger.dev SDK module (cached globally for HMR safety).
 * 真实 SDK API (configure / defineTrigger / runs.trigger 等) 不在本文件直接调用,
 * 留给 lib/trigger-client.ts 二次包装 / PR2+ worker 集成使用.
 *
 * 注意: 这里只 import SDK 顶层 module — 真正的 task 定义走 `@trigger.dev/sdk/v3`.
 * PR1 暂不 import v3 (避免破坏单测)。
 */
export async function getTriggerSdk(): Promise<unknown> {
  if (g.__triggerSdk) return g.__triggerSdk;
  const cfg = resolveTriggerConfig(); // throws if env 未配齐
  // 动态 import 真实 SDK; 真实 SDK v3 task 定义留给后续 PR
  const mod = await import('@trigger.dev/sdk').catch((err) => {
    throw new Error(
      `[Trigger.dev] failed to load @trigger.dev/sdk: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  g.__triggerSdk = mod;
  // 项目级别配置 (PR1 只校验 cfg 形状，不实际 use, 防止 SDK 内部 web-worker 启动)
  void cfg;
  return mod;
}
