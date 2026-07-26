// OutlinePlanner — 第一阶段 LLM 调用。
//
// 读 job.inputPayload.topic → 调 callLlm() → 生成 5-beat outline → 落盘 storage/jobs/{id}/plan.json。
// prompt 用 prompt-cache-friendly：system 是常量 header（跨请求共享），user 是 topic（每次变）。
//
// v0.0.1 简化：beats 是 flat 结构 { id, title, summary, duration_sec, visual_hint }（不是 plan 文件
// 里的 { id, name, duration_ms, purpose } + 独立 visual_plan 数组）。QG-plan 验证结构 + duration 总和。
//
// retry / provider dispatch：callLlm() 内部已经处理（3 次 exponential backoff + 4xx break）。
// 这里只关心"调完拿到 text → 解析 → 落盘"，不重试 LLM。

import { eq } from 'drizzle-orm';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { safeRecordEvent } from '@/lib/job-events';
import { callLlm, parseAssistantJson } from '@/lib/llm';
import { logger } from '@/lib/logger';

// planPathFor 必须每次 evaluate（不能用 module-level STORAGE_ROOT 常量），
// 否则测试 spy process.cwd() 时 module-load 时 STORAGE_ROOT 已固化，spy 失效。
export function planPathFor(jobId: string): string {
  return path.join(process.cwd(), 'storage', 'jobs', jobId, 'plan.json');
}

// ─────────────────────────────────────────────────────────────────
// Schemas（导出，便于 QG-plan 和测试复用）
// ─────────────────────────────────────────────────────────────────

export const BeatSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  // positive() 与 QG-plan 一致：schema 直接拒 0 / 负数，少一处隐式约定
  duration_sec: z.number().int().positive(),
  visual_hint: z.string().min(1),
});
export type Beat = z.infer<typeof BeatSchema>;

export const PlanSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  // .min(1) 让 outline 阶段拒空数组，避免 outline → 落空 plan.json → QG-plan 才报空
  beats: z.array(BeatSchema).min(1),
});
export type Plan = z.infer<typeof PlanSchema>;

// ─────────────────────────────────────────────────────────────────
// Prompts（常量 = 可被 Anthropic/OpenAI 命中 prompt cache）
// ─────────────────────────────────────────────────────────────────

/**
 * System prompt — 跨 job 复用 → 命中 prompt cache。
 * 内容：spec §4.6 头三条铁律 + JSON 输出约束 + schema 说明。
 */
export const SYSTEM_PROMPT = `你正在为 30 秒抖音科普视频生成内容大纲。

铁律（spec §4.6）：
1. 撞墙拐点：同一方向最多 3 版；v3 不行回退 + 选择性吸收，不推倒重来。
2. 第 2 次输出不合规必向系统申请询问，不准直接装 OK 提交。
3. 任何改 html 的 JS 后必跑 probe-console，没 [无 ERR] 不准进入下一阶段。

输出必须是合法 JSON。严格按 schema：
{
  "title": "<视频标题>",
  "topic": "<与用户输入一致>",
  "beats": [
    { "id": "b1", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "..." },
    { "id": "b2", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "..." },
    { "id": "b3", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "..." },
    { "id": "b4", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "..." },
    { "id": "b5", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "..." }
  ]
}

约束：
- 必须正好 5 个 beats
- 每个 beat duration_sec = 6（5 × 6 = 30s）
- 顺序：b1 钩子 → b2 定义 → b3 数字对比 → b4 真实例子 → b5 收尾关键词
- title 让人想点开（数字 + 反常识优先）
- visual_hint 要具体到字号 / 颜色 / 动效层级
`.trim();

/** User prompt — 每个 job 唯一（topic 决定内容） */
export function planPromptFor(topic: string): string {
  return `为这个 topic 做一个 30 秒抖音科普视频的大纲。

topic：${topic}

输出严格按 system prompt 的 schema。只输出 JSON，不要任何前后解释 / markdown 包装。`.trim();
}

// ─────────────────────────────────────────────────────────────────
// Phase entry
// ─────────────────────────────────────────────────────────────────

export async function phaseOutline(jobId: string): Promise<void> {
  const db = getDb();

  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error(`job ${jobId} not found`);

  const payload = job.inputPayload as { topic?: unknown } | null;
  const topic = typeof payload?.topic === 'string' ? payload.topic.trim() : '';
  if (topic.length === 0) {
    throw new Error(`job ${jobId} has no topic in inputPayload`);
  }

  logger.info({ jobId, topic, topicLen: topic.length }, 'outline phase starting');

  const raw = await callLlm({
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: planPromptFor(topic) }],
    maxTokens: 2048,
  });

  let parsed: unknown;
  try {
    parsed = parseAssistantJson(raw);
  } catch (err) {
    // 非 JSON 输出 → 抛错让 pipeline 失败（QG-plan 不在这里 silent pass）
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err), rawLen: raw.length },
      'outline raw output not parseable as JSON',
    );
    await safeRecordEvent(jobId, 'planning_done', 'outline_parse_failed', {
      rawLen: raw.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`outline parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Zod 验证 schema（PlanSchema 允许任意 beats.length；QG-plan 检查 5 + duration 总和）
  const structural = PlanSchema.safeParse(parsed);
  if (!structural.success) {
    logger.warn(
      { jobId, issue: structural.error.flatten() },
      'outline failed structural schema',
    );
    await safeRecordEvent(jobId, 'planning_done', 'outline_schema_failed', {
      issue: structural.error.flatten(),
    });
    throw new Error('outline failed structural schema');
  }

  // 落盘 + 记录事件
  // Atomic write: tmp + rename，crash mid-write 不会让 plan.json 半截 → QG-plan 不卡在 plan_json_invalid
  const planPath = planPathFor(jobId);
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  const tmpPath = `${planPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(structural.data, null, 2), 'utf8');
  await fs.rename(tmpPath, planPath);

  await safeRecordEvent(jobId, 'planning_done', 'outline_persisted', {
    title: structural.data.title,
    beatCount: structural.data.beats.length,
    planPath,
  });

  logger.info(
    { jobId, title: structural.data.title, beats: structural.data.beats.length },
    'outline persisted',
  );
}

// safeRecordEvent 已抽到 @/lib/job-events（共用 outline.ts + script.ts + qg-plan.ts）