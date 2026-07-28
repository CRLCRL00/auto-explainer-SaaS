// v0.5.1 LLM-output QualityGate checks (per docs/superpowers/specs §4.2).
//
// 现实施: QG-plan / QG-script / QG-html 三道 LLM 输出校验.
// 它们和 lib/pipeline/qg-checks.ts (QG-render / QG-final) 不同:
//   - QG-render / QG-final: 断言文件系统产物 (realFps / mp4 size)
//   - QG-plan / QG-script / QG-html: 断言 LLM output schema 内容 (id 完整 / 字数 / 钩子)
//
// 撞墙语义: 任何 QG 不通过 → throw `[non-retryable] qg-X: ...` 让 retry helper
//   立即撞墙 (retry 不改一类变量救 LLM 输出 — 撞墙信号必须传上去)
//   spec §4.4: 'QG plan/script 二次重写仍不过' 是 human-in-loop triggers 第 1 条.
//
// IMPORTANT: QG-plan/script/html 现实施的是 '静态校验' (schema + 字数).
//   LLM-led 'auto-rewrite' (spec §4.2 中描述的 '改一类变量') 由 retry helper
//   在 retry path 中换 prompt seed 实现; 现有 retry helper 没接 LLM 改写逻辑,
//   简化策略: outline/script/html 内仍走 'retry 一次 → 仍 fail → QG 撞墙' 路径,
//   retry 时重置 cache key (由 caller 控制)。完整 LLM-led rewrite 留 v0.5.2.

import { logger } from '../logger';

export class LLMQGFailedError extends Error {
  constructor(public readonly gate: 'qg-plan' | 'qg-script' | 'qg-html', public readonly reason: string) {
    super(`[non-retryable] ${gate}: ${reason}`);
    this.name = 'LLMQGFailedError';
  }
}

// ─────────────────────────────────────────────────────────────────
// QG-plan: 验证 OutlinePlanner 输出 schema + 完整性
// ─────────────────────────────────────────────────────────────────
export interface PlanQGInput {
  // beats[].id: project 用 string ('b1', 'b2' ...); 数字也接受 (用 | 兼容). 仅在错误信息里 format.
  beats: Array<{ id: string | number; title: string; duration_sec: number }>;
  targetDurationSec: number;
}

export function checkPlan(i: PlanQGInput): void {
  if (!Array.isArray(i.beats) || i.beats.length < 3) {
    throw new LLMQGFailedError(
      'qg-plan',
      `plan.beats.length=${i.beats?.length ?? 0} < 3 (PRD: ≥ 3 beats)`,
    );
  }
  if (i.beats.length > 12) {
    throw new LLMQGFailedError(
      'qg-plan',
      `plan.beats.length=${i.beats.length} > 12 (PRD: ≤ 12 beats)`,
    );
  }
  // 检查每节时长加和 (tolerance: ±2s)
  const sumDur = i.beats.reduce((s, b) => s + (b.duration_sec ?? 0), 0);
  if (Math.abs(sumDur - i.targetDurationSec) > 2) {
    throw new LLMQGFailedError(
      'qg-plan',
      `plan 总时长 ${sumDur}s ≠ target ${i.targetDurationSec}s (tolerance ±2s)`,
    );
  }
  // 检查每节标题非空
  for (const b of i.beats) {
    if (!b.title || b.title.trim().length === 0) {
      throw new LLMQGFailedError('qg-plan', `plan.beats[${b.id}].title empty`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// QG-script: 验证 ScriptWriter 输出 (字数 ≈ 时长 × 字速)
// ─────────────────────────────────────────────────────────────────
export interface ScriptQGInput {
  beats: Array<{ id: string | number; narration: string; caption: string }>;
  targetDurationSec: number;
}

const CHINESE_CHARS_PER_SEC = 3.5; // 中文 TTS 平均字速 (~ 210 字/分钟 → 3.5 字/秒). 含停顿与呼吸位.
const SCRIPT_CHAR_TOLERANCE_RATIO = 0.5; // ±50% (LLM 字数 floating + TTS 语速弹性).

export function checkScript(i: ScriptQGInput): void {
  if (!Array.isArray(i.beats) || i.beats.length < 3) {
    throw new LLMQGFailedError('qg-script', `script.beats.length=${i.beats?.length ?? 0} < 3`);
  }
  for (const b of i.beats) {
    if (!b.narration || b.narration.trim().length === 0) {
      throw new LLMQGFailedError('qg-script', `script.beats[${b.id}].narration empty`);
    }
    if (!b.caption || b.caption.trim().length === 0) {
      throw new LLMQGFailedError('qg-script', `script.beats[${b.id}].caption empty`);
    }
  }
  // 字数校验: 全 beats 总字数应与目标时长匹配
  const totalChars = i.beats.reduce((s, b) => s + (b.narration?.length ?? 0), 0);
  const expectedChars = Math.round(i.targetDurationSec * CHINESE_CHARS_PER_SEC);
  const tolerance = Math.max(20, expectedChars * SCRIPT_CHAR_TOLERANCE_RATIO);
  if (Math.abs(totalChars - expectedChars) > tolerance) {
    throw new LLMQGFailedError(
      'qg-script',
      `script 总字数 ${totalChars} 偏离预期 ${expectedChars} (±${tolerance}, ratio ${SCRIPT_CHAR_TOLERANCE_RATIO})`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// QG-html: 验证 HtmlRenderer 输出 (probe-check 不依赖本函数, 这里只查 schema 关键字段)
//   真正 console ERR / DOM check 在 phaseProbe.ts 内 (CG-render 接)
// ─────────────────────────────────────────────────────────────────
export interface HtmlQGInput {
  html: string;
  beatContainerIdPattern: string; // e.g. "beat-"
}

export function checkHtml(i: HtmlQGInput): void {
  if (!i.html || i.html.trim().length === 0) {
    throw new LLMQGFailedError('qg-html', 'html empty');
  }
  // 关键: 至少一个 beat container
  if (!i.html.includes(i.beatContainerIdPattern)) {
    throw new LLMQGFailedError(
      'qg-html',
      `html missing beat container id pattern '${i.beatContainerIdPattern}'`,
    );
  }
}

// ─── backwards-compat alias ─────────────────────────────────────────
export { checkPlan as qgPlan, checkScript as qgScript, checkHtml as qgHtml };

void logger;
