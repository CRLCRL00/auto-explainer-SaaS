import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';

export async function phaseProbe(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const htmlPath = path.join(process.cwd(), 'storage', 'jobs', jobId, 'video.html');
  const html = await fs.readFile(htmlPath, 'utf8');

  // 1. ID 一致性 + 占位符残留检测（你 §20.2 checkIds 原则）
  const placeholderRe = /\{\{([A-Z_0-9]+)\}\}/g;
  const placeholders: string[] = [];
  let m;
  while ((m = placeholderRe.exec(html)) !== null) placeholders.push(m[1]);
  if (placeholders.length > 0) {
    throw new Error(`unresolved placeholders: ${placeholders.join(', ')}`);
  }

  const requiredIds = ['b1', 'b2', 'b3', 'b4', 'b5'];
  for (const id of requiredIds) {
    if (!new RegExp(`id="${id}"`).test(html)) {
      throw new Error(`missing beat id #${id}`);
    }
  }

  // 2. 真实浏览器探针（headless）
  logger.info({ jobId }, 'probe starting');
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto('file:///' + htmlPath.replace(/\\/g, '/'), { waitUntil: 'load' });
  await page.waitForFunction(() => (window as any).__ready === true, { timeout: 5000 });

  // 强制翻到第 1 屏 + 检查 class
  await page.evaluate(() => {
    const el = document.getElementById('b1');
    el?.classList.add('in');
  });
  await page.waitForTimeout(500);
  const b1Visible = await page.evaluate(() => document.getElementById('b1')?.classList.contains('in'));
  const b2Missing = await page.evaluate(() => !document.getElementById('b2'));

  await browser.close();

  if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join('; ')}`);
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join('; ')}`);
  if (!b1Visible) throw new Error('b1 did not enter visible state');
  if (b2Missing) throw new Error('b2 element missing at runtime');

  logger.info({ jobId }, 'probe passed');
}
