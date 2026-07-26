// QG-plan — OutlinePlanner 的 quality gate (spec §4.2)。
//
// 输入：storage/jobs/{jobId}/plan.json（outline.ts 刚落盘的）。
// 判定：
//   - 5 个 beats 都有 title / summary / duration_sec / visual_hint（BeatSchema 必填字段）
//   - 每个 beat duration_sec > 0
//   - 5 beats 的 duration_sec 总和 <= 60（v0.0.1 帧 30s × 2 fps 上限 = 60s 安全垫）
//
// 不通过 → 抛错让 pipeline.ts catch 转 failed 状态（不 silent pass）。
// v0.0.1 简化：不做语义质量判断（标题反常识、钩子冲击力等留 v0.5）。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobEvents, jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';
import { BeatSchema, PlanSchema } from './outline';

/** QG-plan 阈值：beats 总和上限（秒）。worker 单帧 30s，5 beats 30s/beat 上限是 150s，但当前模板 beat5-30s 是 5×6s=30s；给 60s 留后续 60s 模板的空间。 */
export const MAX_TOTAL_DURATION_SEC = 60;
export const EXPECTED_BEAT_COUNT = 5;

export class QgPlanError extends Error {
  readonly code: string;
  readonly details: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'QgPlanError';
    this.code = code;
    this.details = details;
  }
}

export async function phaseQgPlan(jobId: string): Promise<void> {
  const db = getDb();

  const planPath = path.join(process.cwd(), 'storage', 'jobs', jobId, 'plan.json');
  const raw = await fs.readFile(planPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new QgPlanError(
      'plan_json_invalid',
      `plan.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 结构 schema（每个 beat 必填字段）
  const structural = PlanSchema.safeParse(parsed);
  if (!structural.success) {
    throw new QgPlanError(
      'plan_schema_invalid',
      'plan.json does not match PlanSchema',
      structural.error.flatten(),
    );
  }

  const plan = structural.data;

  // beats 数量
  if (plan.beats.length !== EXPECTED_BEAT_COUNT) {
    throw new QgPlanError(
      'plan_beat_count',
      `expected ${EXPECTED_BEAT_COUNT} beats, got ${plan.beats.length}`,
      { expected: EXPECTED_BEAT_COUNT, actual: plan.beats.length },
    );
  }

  // 每个 beat 单独再过 BeatSchema（防止 PlanSchema 后续放宽）
  const beatIssues: Array<{ index: number; issue: unknown }> = [];
  plan.beats.forEach((beat, i) => {
    const r = BeatSchema.safeParse(beat);
    if (!r.success) {
      beatIssues.push({ index: i, issue: r.error.flatten() });
    }
  });
  if (beatIssues.length > 0) {
    throw new QgPlanError(
      'plan_beat_schema',
      'one or more beats failed BeatSchema',
      beatIssues,
    );
  }

  // duration_sec 总和
  const total = plan.beats.reduce((sum, b) => sum + b.duration_sec, 0);
  if (total > MAX_TOTAL_DURATION_SEC) {
    throw new QgPlanError(
      'plan_duration_exceeded',
      `total duration_sec ${total} exceeds MAX_TOTAL_DURATION_SEC ${MAX_TOTAL_DURATION_SEC}`,
      { total, max: MAX_TOTAL_DURATION_SEC },
    );
  }

  // 每个 beat duration_sec > 0
  const zeroBeats = plan.beats
    .map((b, i) => ({ index: i, id: b.id, duration_sec: b.duration_sec }))
    .filter((x) => x.duration_sec <= 0);
  if (zeroBeats.length > 0) {
    throw new QgPlanError(
      'plan_beat_zero_duration',
      'one or more beats have non-positive duration_sec',
      zeroBeats,
    );
  }

  // 通过 → 落事件（best-effort，不阻塞）
  try {
    await db.insert(jobEvents).values({
      jobId,
      phase: 'planning_done',
      event: 'qg_plan_passed',
      payload: { total, beatCount: plan.beats.length },
    });
    // QG-plan 通过后才把 templateId 钉死（template 由 beats 数隐式决定）
    await db.update(jobs).set({ templateId: 'beat5-30s' }).where(eq(jobs.id, jobId));
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err) },
      'QG-plan post-pass persistence failed (non-fatal)',
    );
  }

  logger.info(
    { jobId, total, beatCount: plan.beats.length },
    'QG-plan passed',
  );
}