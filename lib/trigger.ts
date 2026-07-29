// Trigger.dev v4 SDK wrapper (P1 PR1: 引入基础设施, 不切流).
//
// PR1 设计：仅提供 lazy client factory + 同步 API surface.
// PR3 (RUN_TRIGGER_DEV=1 default) + PR4 (BullMQ 删除) 后是真正的 enqueue 入口.
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

// ─────────────────────────────────────────────────────────────────
// P1 PR2: triggerJob(payload) — server-side SDK 调用 (tasks.trigger)
// ─────────────────────────────────────────────────────────────────

const TASK_IDENTIFIER = 'process-video-job';

/**
 * 通过 Trigger.dev v3 SDK tasks.trigger 提交任务。
 *
 * 重要语义:
 *   - 必须 RUN_TRIGGER_DEV=1 且 env vars 配齐 (resolveTriggerConfig throw 否则)
 *   - 实际 SDK 调用必先 configure() (lazy 每次 call 配一次; PR3 worker startup 移 top-level)
 *   - SDK 未真正 configure 时, tasks.trigger() 会 throw — 这是 PR2 期望的"先 trigger 后 catch fallback"
 *   - 失败应该被 caller catch, 不允许冒泡到顶层 (POST /api/jobs 期望 201 任何路径都 OK)
 *
 * 测试细节: vi.mock('@trigger.dev/sdk/v3') 注入 mock 后这个函数能跑可断言。
 */
export async function triggerJob(payload: { jobId: string }): Promise<{ runId: string }> {
  const cfg = resolveTriggerConfig(); // throws if env 关 / 字段缺失
  // 动态 import SDK 顶层 + 真实 v3 入口 (顶层 '@trigger.dev/sdk' 重导出 v3 module)
  const sdk = (await import('@trigger.dev/sdk/v3')) as {
    configure?: (opts: { secretKey: string; apiUrl: string; projectRef: string }) => void;
    tasks?: { trigger?: (id: string, payload: object) => Promise<{ id: string }> };
  };
  if (typeof sdk.configure !== 'function' || !sdk.tasks?.trigger) {
    throw new Error(
      `[Trigger.dev] SDK v3 顶层导出缺 configure/tasks.trigger — SDK 版本不兼容或 mock 不正确`,
    );
  }
  // configure 是 idempotent; PR2 stub 暂每 call 配一次 (PR3 worker startup 移 top-level)
  sdk.configure({
    secretKey: cfg.secretKey,
    apiUrl: cfg.apiUrl,
    projectRef: cfg.projectRef,
  });
  const handle = await sdk.tasks.trigger(TASK_IDENTIFIER, payload);
  if (!handle?.id) {
    throw new Error(`[Trigger.dev] tasks.trigger 未返回 run id (${JSON.stringify(handle)})`);
  }
  return { runId: handle.id };
}

// ─────────────────────────────────────────────────────────────────
// dev mode 旁路 — 不依赖 trigger-web 容器, 也不写真渲染管线.
// ─────────────────────────────────────────────────────────────────
//
// 设计动机: local dev 默认 RUN_TRIGGER_DEV=1 时 SDK 真发请求到 trigger-web:3030
// (docker-compose). 即使 trigger-web 起来, runPipeline 还会调 anthropic / creatomate
// — dev 用户没真 key 时整个 queue 卡在 LLM 401 / Render 401. 让 dev '点击开始生成'
// 立刻 201 之后, /jobs/[id] polling page stuck 在 pending — user 又报 '没反应'.
//
// inlineDevEnqueue 改成 dev **status walk-through simulator**: fire-and-forget
// 5s 后用 db update 把 jobs.status walk through.
//   - t=1s phase='recording_done', status='running'
//   - t=5s phase='done', status='done', finishedAt=now
// 不写真写 storage/jobs/<id>/video.mp4 (这与 user '不一定要直接出 mp4' 反馈一致 —
// 部署侧真跑 pipeline 时由 Creatomate 写真写入).
//
// prod 仍走 triggerJob (真 trigger-web workqueue). dev inline 仅在:
//   NODE_ENV !== 'production' 启用 + 没有 RUN_PIPELINE_MODE=real 这类显式 prod 标记

export async function inlineDevEnqueue(payload: { jobId: string }): Promise<{ runId: string }> {
  const runId = `dev-inline-${payload.jobId.slice(0, 8)}`;

  // dynamic import 避免 ESM cycle (worker/pipeline → lib/trigger → worker/pipeline)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (async () => {
    try {
      // dynamic import 整个 db + schema (避免 route 模块触发 unused deps)
      const { getDb } = (await import('@/lib/db')) as unknown as { getDb: () => unknown };
      const { jobs } = (await import('@/lib/schema')) as unknown as { jobs: unknown };
      const { eq } = (await import('drizzle-orm')) as unknown as { eq: (a: unknown, b: unknown) => unknown };
      const db = getDb() as {
        update: (table: unknown) => {
          set: (v: Record<string, unknown>) => {
            where: (cond: unknown) => Promise<unknown>;
          };
        };
      };

      // t=1s: move to recording_done — 看 page 看到 phase step 切换
      await new Promise((r) => setTimeout(r, 1_000));
      await db.update(jobs).set({ phase: 'recording_done', status: 'running' }).where(eq((jobs as { id: unknown }).id, payload.jobId));

      // t=2-3s: encoded (creatomate_rendering phase — 同 enum 值, 但不是真渲染)
      await new Promise((r) => setTimeout(r, 2_000));
      await db.update(jobs).set({ phase: 'creatomate_rendering' }).where(eq((jobs as { id: unknown }).id, payload.jobId));

      // t=2s 后: done (5s total)
      await new Promise((r) => setTimeout(r, 2_000));
      await db.update(jobs).set({
        phase: 'done',
        status: 'done',
        finishedAt: new Date(),
      }).where(eq((jobs as { id: unknown }).id, payload.jobId));

      // inlineDevEnqueue runs only in dev mode (NODE_ENV !== 'production').
      // No logger import — lib/logger depends on lib/env which test mocks may
      // nullify; console.* is fine for this dev-only code path.
      // eslint-disable-next-line no-console
      console.log(`[dev inline] ${payload.jobId} → done (5s walk-through)`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[dev inline runPipeline failed]', payload.jobId, err);
    }
  })();
  return { runId };
}
