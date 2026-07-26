import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';

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

  // 写产物
  const outPath = path.join(jobDir, 'video.html');
  await fs.writeFile(outPath, tpl, 'utf8');
  await db.insert((await import('@/lib/schema')).jobArtifacts).values({
    jobId, kind: 'html', storagePath: outPath,
  });

  logger.info({ jobId, htmlPath: outPath }, 'html rendered');
}