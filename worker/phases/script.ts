// ScriptWriter — 第二阶段 LLM 调用（spec §4.6）。
//
// 读 storage/jobs/{jobId}/plan.json（flat schema）→ 调 callLlm() → 为每个 beat
// 生成 narration（口播正文）+ caption（字幕）+ tts_text（TTS 输入） → 落盘
// storage/jobs/{jobId}/script.json。
//
// prompt-cache-friendly：SYSTEM_PROMPT 是 module-level const（跨请求共享），
// user prompt 是 plan 摘要（每次变）。
//
// 输入 schema 复用 outline.ts 的 BeatSchema / PlanSchema（flat：id/title/summary/
// duration_sec/visual_hint），不再用旧的 {id,name,duration_ms,purpose}+visual_plan[]。
//
// retry / provider dispatch：callLlm() 内部已经处理（3 次 exponential backoff +
// 4xx break）。这里只关心"调完拿到 text → 解析 → 落盘"，不重试 LLM。

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { callLlm, parseAssistantJson } from '@/lib/llm';
import { logger } from '@/lib/logger';
import { safeRecordEvent } from '@/lib/job-events';
import { checkScript as qgCheckScript } from '@/lib/pipeline/qg-checks-llm';
import { BeatSchema, PlanSchema, planPathFor } from './outline';

// ─────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────

// scriptPathFor 必须每次 evaluate（不能用 module-level 常量），同 planPathFor。
export function scriptPathFor(jobId: string): string {
  return path.join(process.cwd(), 'storage', 'jobs', jobId, 'script.json');
}

// ─────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────

/** ScriptJson 一行 beat：plan beat + 三个文本字段（narration / caption / tts_text）。
 *
 * 长度上限参考 6s/beat × 250字/分钟 TTS 字速 ≈ 25 字，prompt 里 ≤30/≤20 是宽松软约束。
 * schema 用 max 兜底防止 LLM 严重超标（按 JS code unit 计数；中文字符 = 1 unit）。
 */
export const ScriptBeatSchema = BeatSchema.extend({
  narration: z.string().min(1).max(60),
  caption: z.string().min(1).max(40),
  tts_text: z.string().min(1).max(60),
});
export type ScriptBeat = z.infer<typeof ScriptBeatSchema>;

export const ScriptSchema = z.object({
  title: z.string().min(1),
  topic: z.string().min(1),
  // .length(5) 严格保证与 plan 一致；不靠 prompt 软约束
  beats: z.array(ScriptBeatSchema).length(5),
});
export type ScriptJson = z.infer<typeof ScriptSchema>;

// ─────────────────────────────────────────────────────────────────
// Prompts（module-level const = prompt-cache-friendly）
// ─────────────────────────────────────────────────────────────────

/**
 * System prompt — 跨 job 复用 → 命中 prompt cache。
 * 内容：spec §4.6 头三条铁律 + JSON 输出约束 + schema 说明。
 */
export const SYSTEM_PROMPT = `你正在为 30 秒抖音科普视频写每段口播稿。

铁律（spec §4.6）：
1. 撞墙拐点：同一方向最多 3 版；v3 不行回退 + 选择性吸收，不推倒重来。
2. 第 2 次输出不合规必向系统申请询问，不准直接装 OK 提交。
3. 任何改 html 的 JS 后必跑 probe-console，没 [无 ERR] 不准进入下一阶段。

输出必须是合法 JSON。严格按 schema：
{
  "title": "<沿用 plan 标题>",
  "topic": "<沿用 plan topic>",
  "beats": [
    { "id": "b1", "title": "...", "summary": "...", "duration_sec": 6, "visual_hint": "...",
      "narration": "<口播正文，6 秒念完 ≈ 30 字以内>",
      "caption": "<字幕短句，与 narration 同步、便于快速扫读>",
      "tts_text": "<TTS 输入文本：与 narration 一致，但去掉换行 / 表情符号 / 多余标点>" },
    ... (5 个 beats)
  ]
}

约束：
- 必须正好 5 个 beats（沿用 plan 的 id / title / summary / duration_sec / visual_hint）
- 每段 narration 中文字数 ≤ 30（按 250 字/分钟 算）
- narration 不要"大家好"开篇；钩子段（b1）第 1 句必须有反常识冲击力
- caption 比 narration 更短（≤ 20 字），便于快速扫读
- tts_text 与 narration 内容一致，但移除表情符号、多余换行、连续标点
- 收尾段（b5）必须有一句"关键词 + 一句话本质"
`.trim();

/** User prompt — 每个 job 唯一（plan 内容决定）。 */
export function scriptPromptFor(plan: {
  title: string;
  topic: string;
  beats: ReadonlyArray<{
    id: string;
    title: string;
    summary: string;
    duration_sec: number;
    visual_hint: string;
  }>;
}): string {
  const beatsJson = JSON.stringify(
    plan.beats.map((b) => ({
      id: b.id,
      title: b.title,
      summary: b.summary,
      duration_sec: b.duration_sec,
      visual_hint: b.visual_hint,
    })),
    null,
    2,
  );

  return `为以下视频生成每段口播稿（narration / caption / tts_text）。

title：${plan.title}
topic：${plan.topic}

beats（沿用 id / title / summary / duration_sec / visual_hint，不要改）：
${beatsJson}

输出严格按 system prompt 的 schema。只输出 JSON，不要任何前后解释 / markdown 包装。`.trim();
}

// ─────────────────────────────────────────────────────────────────
// Phase entry
// ─────────────────────────────────────────────────────────────────

export async function phaseScript(jobId: string): Promise<void> {
  // 1. 读 plan.json（flat schema）
  const planPath = planPathFor(jobId);
  let planRaw: string;
  try {
    planRaw = await fs.readFile(planPath, 'utf8');
  } catch (err) {
    // file-not-found / ENOENT → 抛错让 pipeline 转 failed（QG-plan 已写过 plan.json，
    // 这里再缺只能是文件被外部删了 / 上游 phase 没跑 → fail-fast）。
    logger.warn(
      { jobId, planPath, err: err instanceof Error ? err.message : String(err) },
      'script: plan.json read failed',
    );
    throw new Error(
      `script: plan.json not readable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(planRaw);
  } catch (err) {
    logger.warn(
      { jobId, planPath, err: err instanceof Error ? err.message : String(err) },
      'script: plan.json not valid JSON',
    );
    throw new Error(
      `script: plan.json not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const structural = PlanSchema.safeParse(parsed);
  if (!structural.success) {
    logger.warn(
      { jobId, issue: structural.error.flatten() },
      'script: plan.json failed PlanSchema',
    );
    throw new Error('script: plan.json does not match PlanSchema');
  }

  const plan = structural.data;

  // 2. 调 LLM 生成三个文本字段 / beat
  logger.info(
    { jobId, title: plan.title, beats: plan.beats.length },
    'script phase starting',
  );

  const raw = await callLlm({
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: scriptPromptFor(plan) },
    ],
    maxTokens: 4096,
  });

  let parsedScript: unknown;
  try {
    parsedScript = parseAssistantJson(raw);
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err), rawLen: raw.length },
      'script raw output not parseable as JSON',
    );
    await safeRecordEvent(jobId, 'script_ready', 'script_parse_failed', {
      rawLen: raw.length,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(
      `script parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Zod 验证 ScriptSchema
  const scriptCheck = ScriptSchema.safeParse(parsedScript);
  if (!scriptCheck.success) {
    logger.warn(
      { jobId, issue: scriptCheck.error.flatten() },
      'script failed structural schema',
    );
    await safeRecordEvent(jobId, 'script_ready', 'script_schema_failed', {
      issue: scriptCheck.error.flatten(),
    });
    throw new Error('script failed structural schema');
  }

  const scriptJson = scriptCheck.data;

  // 3. 验证 LLM 输出严格沿用 plan 字段（QG-plan 校验过的内容不能再被绕开）
  //    title / topic 必须一致；每个 beat 的 id / title / summary / duration_sec / visual_hint 必须逐项相等。
  const drift = detectPlanDrift(plan, scriptJson);
  if (drift) {
    logger.warn({ jobId, drift }, 'script output drifted from plan');
    await safeRecordEvent(jobId, 'script_ready', 'script_plan_drift', { drift });
    throw new Error(`script output drifted from plan: ${drift}`);
  }

  // v0.6.1 集成 QG-script helper (lib/pipeline/qg-checks-llm.ts:checkScript):
  //   - beats.length >= 3 (script schema 已 length(5) 兜了, 这里 double-check)
  //   - 每 beat narration + caption 非空 (schema min(1) 也守了, double-check)
  //   - 总字数 ≈ targetDurationSec × 3.5 中文字符/秒 ± 50% (CHINESE_CHARS_PER_SEC 常量).
  //     PRD: 30s 视频 ≈ 105 字, ±52 字 (TTS 语速弹性).
  // 失败 throw LLMQGFailedError('qg-script', ...) — pipeline retry helper 立即撞墙.
  try {
    const targetDurationSec = plan.beats.reduce((s, b) => s + b.duration_sec, 0);
    qgCheckScript({
      beats: scriptJson.beats.map((b) => ({ id: b.id, narration: b.narration, caption: b.caption })),
      targetDurationSec,
    });
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err) },
      'script failed QG-script helper',
    );
    await safeRecordEvent(jobId, 'script_ready', 'qg_script_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // 4. 落盘 script.json（atomic write：tmp + rename）
  const scriptPath = scriptPathFor(jobId);
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  const tmpPath = `${scriptPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(scriptJson, null, 2), 'utf8');
  await fs.rename(tmpPath, scriptPath);

  await safeRecordEvent(jobId, 'script_ready', 'script_persisted', {
    title: scriptJson.title,
    beatCount: scriptJson.beats.length,
    scriptPath,
  });

  logger.info(
    { jobId, title: scriptJson.title, beats: scriptJson.beats.length },
    'script persisted',
  );
}

/**
 * 返回 null = 无 drift；返回 string = 不一致原因（用于 safeRecordEvent payload + throw message）。
 */
function detectPlanDrift(
  plan: { title: string; topic: string; beats: ReadonlyArray<{ id: string; title: string; summary: string; duration_sec: number; visual_hint: string }> },
  script: { title: string; topic: string; beats: ReadonlyArray<{ id: string; title: string; summary: string; duration_sec: number; visual_hint: string }> },
): string | null {
  if (plan.title !== script.title) return `title drift: plan="${plan.title}" script="${script.title}"`;
  if (plan.topic !== script.topic) return `topic drift: plan="${plan.topic}" script="${script.topic}"`;
  if (plan.beats.length !== script.beats.length) {
    return `beats length drift: plan=${plan.beats.length} script=${script.beats.length}`;
  }
  for (let i = 0; i < plan.beats.length; i++) {
    const p = plan.beats[i];
    const s = script.beats[i];
    if (p.id !== s.id) return `beat[${i}].id drift: plan="${p.id}" script="${s.id}"`;
    if (p.title !== s.title) return `beat[${i}].title drift`;
    if (p.summary !== s.summary) return `beat[${i}].summary drift`;
    if (p.duration_sec !== s.duration_sec) return `beat[${i}].duration_sec drift: plan=${p.duration_sec} script=${s.duration_sec}`;
    if (p.visual_hint !== s.visual_hint) return `beat[${i}].visual_hint drift`;
  }
  return null;
}