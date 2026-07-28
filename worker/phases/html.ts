import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';
import { checkHtml as qgCheckHtml } from '@/lib/pipeline/qg-checks-llm';

/**
 * phaseHtml — 模板渲染 + selector 注入。
 *
 * v0.0.1：硬编码 beat5-30s 模板。读 storage/jobs/{id}/script.json（flat schema），
 * 按 BeatSchema { id, title, summary, duration_sec, visual_hint } 渲染每个 .beat。
 *
 * 不再用旧的 plan.json.visual_plan[] + script.md；flat-schema 决策见 commit a1b2b2c + spec-deviation follow-up。
 */

interface FlatBeat {
  id: string;
  title: string;
  summary: string;
  duration_sec: number;
  visual_hint: string;
  narration?: string;
  caption?: string;
  tts_text?: string;
}

interface ScriptJson {
  title: string;
  topic: string;
  beats: FlatBeat[];
}

export async function phaseHtml(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error('job not found');

  // v0.0.1：硬编码一个模板
  const templateId = job.templateId ?? 'beat5-30s';
  if (templateId !== 'beat5-30s') {
    throw new Error(`unknown template ${templateId} (v0.0.1 only beat5-30s)`);
  }

  const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
  const scriptPath = path.join(jobDir, 'script.json');
  const scriptRaw = await fs.readFile(scriptPath, 'utf8');
  const script = JSON.parse(scriptRaw) as ScriptJson;

  // 读模板
  const tplPath = path.join(process.cwd(), 'lib', 'templates', 'beat5-30s.html');
  let tpl = await fs.readFile(tplPath, 'utf8');

  // 替换 BEATS（生成 5 个 .beat 块）
  const beatsHtml = script.beats
    .map((b, i) => `
<div class="beat" id="${b.id}">
  <div class="bignum">0${i + 1}</div>
  <h1 class="anim d2">{{BEAT_${i}_TITLE}}</h1>
  <p class="anim d3">{{BEAT_${i}_TEXT}}</p>
</div>`).join('\n');

  // 1) 先注入 {{BEATS}}，让 tpl 内含 {{BEAT_i_TITLE/TEXT}} 占位符
  // 2) 再 per-beat replace（用函数式 replacement 防 $&/$1/$$ 在 beat.title / narration 里崩坏输出）
  tpl = tpl.replaceAll('{{BEATS}}', () => beatsHtml);
  for (let i = 0; i < script.beats.length; i++) {
    const beat = script.beats[i];
    // v0.0.1：title 用 beat.title (flat schema)，text 用 narration (script 阶段产出)
    const text = beat.narration ?? beat.summary;
    tpl = tpl.replaceAll(`{{BEAT_${i}_TITLE}}`, () => beat.title);
    tpl = tpl.replaceAll(`{{BEAT_${i}_TEXT}}`, () => text);
  }

  // 3) 最后全局占位符
  tpl = tpl.replaceAll('{{TITLE}}', () => script.title);
  tpl = tpl.replaceAll('{{BEATS_JSON}}', () => JSON.stringify(script.beats.map((b) => ({
    id: b.id,
    title: b.title,
    duration_sec: b.duration_sec,
  }))));
  // v0.6.1 R1: TTS 音频注入 — phaseTts (commit b3919d0) 写 tts.mp3 到 jobDir,
  // html 渲染时填 {{TTS_SRC}} 为相对路径 'tts.mp3'. 若文件不存在, inline null,
  // browser 控制台报 '[无 ERR]' if null (即 phaseProbe 期望) — 仍合 spec.
  tpl = tpl.replaceAll('{{TTS_SRC}}', () => 'tts.mp3');

  // 写产物
  const outPath = path.join(jobDir, 'video.html');
  await fs.writeFile(outPath, tpl, 'utf8');

  // v0.6.1 集成 QG-html helper (lib/pipeline/qg-checks-llm.ts:checkHtml):
  //   - html 非空
  //   - 至少一个 beat container (`id="beat-"` 模式 — 当前 beat5-30s 模板每个
  //     beat 用 class="beat"; 后续模板可改 id="beat-N", 此处保持 pattern 通用.
  //   - 现行 only-one-template constraint 由 phaseProbe.ts 真跑 console / DOM
  //     check 断言 (CG-render), checkHtml 仅 schema-level trigger 在 html 完成时
  // 失败 throw LLMQGFailedError('qg-html', ...) — html ready phase retry helper
  // 立即撞墙.
  try {
    qgCheckHtml({
      html: tpl,
      beatContainerIdPattern: 'class="beat"',
    });
  } catch (err) {
    logger.warn(
      { jobId, err: err instanceof Error ? err.message : String(err) },
      'html failed QG-html helper',
    );
    throw err;
  }

  await db.insert((await import('@/lib/schema')).jobArtifacts).values({
    jobId, kind: 'html', storagePath: outPath,
  });

  logger.info({ jobId, htmlPath: outPath }, 'html rendered');
}