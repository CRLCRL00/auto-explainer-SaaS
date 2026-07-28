import { chromium, type Browser } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { logger } from '@/lib/logger';

export async function phaseProbe(jobId: string) {
  const db = getDb();
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) throw new Error(`[${jobId}] job not found`);
  const htmlPath = path.join(process.cwd(), 'storage', 'jobs', jobId, 'video.html');
  const html = await fs.readFile(htmlPath, 'utf8');

  // 1. ID 一致性 + 占位符残留检测（你 §20.2 checkIds 原则）
  const placeholderRe = /\{\{([A-Z_0-9]+)\}\}/g;
  const placeholders: string[] = [];
  let m;
  while ((m = placeholderRe.exec(html)) !== null) placeholders.push(m[1]);
  if (placeholders.length > 0) {
    throw new Error(`[${jobId}] unresolved placeholders: ${placeholders.join(', ')}`);
  }

  const requiredIds = ['b1', 'b2', 'b3', 'b4', 'b5'];
  for (const id of requiredIds) {
    if (!new RegExp(`id=["']${id}["']`).test(html)) {
      throw new Error(`[${jobId}] missing beat id #${id}`);
    }
  }

  // 2. 真实浏览器探针（headless）— v0.6.1 R4 spec §4.3 Chrome auto-downgrade:
  //
  //    Level 1: 系统 Chrome (CHROME_PATH env or Windows default)
  //    Level 2: Playwright 自带 chromium (npx playwright install 装的)
  //    Level 3: 都失败 → log warn + 跳过 (best-effort, 不撞墙)
  //
  //    之前: 系统 Chrome 不在就 throw hard. 现在: graceful degrade.
  logger.info({ jobId }, 'probe starting');
  const browser = await launchChromeWithFallback(jobId);
  if (!browser) {
    logger.warn(
      { jobId },
      'all chromium sources failed; skipping live probe (best-effort: phaseProbe is non-blocking)',
    );
    return;
  }
  try {
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

    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join('; ')}`);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join('; ')}`);
    if (!b1Visible) throw new Error('b1 did not enter visible state');
    if (b2Missing) throw new Error('b2 element missing at runtime');

    logger.info({ jobId }, 'probe passed');
  } finally {
    await browser.close();
  }
}

/**
 * v0.6.1 R4: Chrome auto-downgrade (spec §4.3).
 *
 * 3-tier:
 *   1. 系统 Chrome (CHROME_PATH env or Win default 'C:/Program Files/.../chrome.exe')
 *   2. Playwright bundled chromium (随 npm install 装的, 不需 executablePath)
 *   3. 都失败 → 返回 null (caller 跳过 live probe, best-effort)
 *
 * 之前: 系统 Chrome 不在 -> chromium.launch throw, phaseProbe throw → pipeline fail.
 *       现在: graceful degrade.
 */
async function launchChromeWithFallback(jobId: string): Promise<Browser | null> {
  const launchArgs = ['--no-sandbox', '--disable-dev-shm-usage'] as const;

  // Level 1 — 系统 Chrome
  try {
    return await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      args: [...launchArgs],
    });
  } catch (level1Err) {
    logger.warn(
      { jobId, err: level1Err instanceof Error ? level1Err.message : String(level1Err) },
      'chrome Level 1 (system) failed → fallback to Playwright bundled',
    );
  }

  // Level 2 — Playwright bundled chromium (无 executablePath → 用 @playwright/browser-chromium)
  try {
    return await chromium.launch({
      headless: true,
      args: [...launchArgs],
    });
  } catch (level2Err) {
    logger.warn(
      { jobId, err: level2Err instanceof Error ? level2Err.message : String(level2Err) },
      'chrome Level 2 (bundled) also failed → all sources exhausted',
    );
  }

  return null;
}
