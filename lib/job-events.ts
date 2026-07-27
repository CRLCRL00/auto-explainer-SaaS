import { getDb } from './db';
import { jobEvents } from './schema';
import { logger } from './logger';

export async function recordEvent(
  jobId: string,
  phase: string,
  event: string,
  payload?: unknown,
) {
  const db = getDb();
  await db.insert(jobEvents).values({
    jobId,
    phase,
    event,
    payload,
  });
}

/**
 * Best-effort event 落库：DB 任何错误只 logger.warn，不抛。
 * 用于不阻塞主流程的事件记录（如 outline_persisted / qg_plan_passed / script_persisted）。
 * phase 文件不应该自己再实现 private version。
 */
export async function safeRecordEvent(
  jobId: string,
  phase: string,
  event: string,
  payload?: unknown,
): Promise<void> {
  try {
    await recordEvent(jobId, phase, event, payload);
  } catch (err) {
    logger.warn(
      { jobId, phase, event, err: err instanceof Error ? err.message : String(err) },
      'safeRecordEvent failed (non-fatal)',
    );
  }
}

// P0 全量: Creatomate render lifecycle events — 落 job_events 表为运维 audit.
// 用 `as const` 保持字符串字面量类型，caller 不需要关心 enum 字符串。
export const CreatomateEvents = {
  RenderStarted: 'creatomate_render_started',
  RenderProgress: 'creatomate_render_progress',
  RenderCompleted: 'creatomate_render_completed',
  RenderFailed: 'creatomate_render_failed',
} as const;
export type CreatomateEventName = typeof CreatomateEvents[keyof typeof CreatomateEvents];
