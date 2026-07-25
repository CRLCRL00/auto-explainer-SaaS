import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';

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
  const plan = JSON.parse(await fs.readFile(path.join(jobDir, 'plan.json'), 'utf8'));

  // 读模板
  const tplPath = path.join(process.cwd(), 'lib', 'templates', 'beat5-30s.html');
  let tpl = await fs.readFile(tplPath, 'utf8');

  // 替换 BEATS（生成 5 个 .beat 块）
  const beatsHtml = plan.beats
    .map((b: any, i: number) => `
<div class="beat" id="${b.id}">
  <div class="bignum">0${i + 1}</div>
  <h1 class="anim d2">{{BEAT_${i}_TITLE}}</h1>
  <p class="anim d3">{{BEAT_${i}_TEXT}}</p>
</div>`).join('\n');

  // 替换 BEAT 标题 + 文本（来自 plan.visual_plan + script.md）
  const scriptPath = path.join(jobDir, 'script.md');
  const scriptRaw = await fs.readFile(scriptPath, 'utf8');
  const scriptBeats = parseScriptMd(scriptRaw);

  for (let i = 0; i < plan.beats.length; i++) {
    const beat = plan.beats[i];
    const text = scriptBeats.get(beat.id) ?? '';
    const tplPlaceholder = `{{BEAT_${i}_TITLE}}`;
    // v0.0.1：title 用 beat.name，text 用 script
    tpl = tpl.replace(tplPlaceholder, beat.name);
    tpl = tpl.replace(`{{BEAT_${i}_TEXT}}`, text);
  }

  tpl = tpl.replace('{{TITLE}}', plan.title);
  tpl = tpl.replace('{{BEATS}}', beatsHtml);
  tpl = tpl.replace('{{BEATS_JSON}}', JSON.stringify(plan.beats.map((b: any) => ({
    id: b.id, name: b.name, duration_ms: b.duration_ms,
  }))));

  // 写产物
  const outPath = path.join(jobDir, 'video.html');
  await fs.writeFile(outPath, tpl, 'utf8');
  await db.insert((await import('@/lib/schema')).jobArtifacts).values({
    jobId, kind: 'html', storagePath: outPath,
  });

  logger.info({ jobId, htmlPath: outPath }, 'html rendered');
}

export function parseScriptMd(md: string): Map<string, string> {
  const map = new Map<string, string>();
  const blocks = md.split(/^## /m).slice(1);
  for (const block of blocks) {
    const [headLine, ...rest] = block.split('\n');
    const beatId = headLine.trim().split(' ')[0];
    const text = rest.join('\n').trim();
    map.set(beatId, text);
  }
  return map;
}