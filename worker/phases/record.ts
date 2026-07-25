import puppeteer from 'puppeteer-core';
import fs from 'fs/promises';
import path from 'path';
import { logger } from '@/lib/logger';

const CHROME_PATH = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export async function phaseRecord(jobId: string) {
  const jobDir = path.join(process.cwd(), 'storage', 'jobs', jobId);
  const htmlPath = path.join(jobDir, 'video.html');
  const framesDir = path.join(jobDir, 'frames');
  await fs.rm(framesDir, { recursive: true, force: true });
  await fs.mkdir(framesDir, { recursive: true });

  const htmlUrl = 'file:///' + htmlPath.replace(/\\/g, '/');

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars'],
  });

  let frameIdx = 0;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      history.replaceState({}, '', location.pathname + '?autoplay=1');
      location.reload();
    });
    // 等 ?autoplay=1 触发
    await new Promise((r) => setTimeout(r, 800));
    await page.waitForFunction(() => (window as any).__ready === true, { timeout: 5000 });

    // CDP screencast (60fps target)
    const client = await page.target().createCDPSession();
    await client.send('Page.startScreencast', {
      format: 'png', quality: 85,
      maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
    });

    await new Promise<void>((resolve) => {
      client.on('Page.screencastFrame', async ({ data, sessionId }) => {
        const filename = path.join(framesDir, `f_${String(frameIdx).padStart(5, '0')}.png`);
        await fs.writeFile(filename, Buffer.from(data, 'base64'));
        frameIdx++;
        await client.send('Page.screencastFrameAck', { sessionId });
      });
      // 总时长 32s（30s + 2s buffer）
      setTimeout(resolve, 32000);
    });

    await client.send('Page.stopScreencast');
  } catch (err) {
    throw new Error(`[${jobId}] recording failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await browser.close();
  }

  logger.info({ jobId, frames: frameIdx }, 'recording done');
}
