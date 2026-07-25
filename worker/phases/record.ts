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

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--hide-scrollbars'],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    await page.goto(htmlUrl, { waitUntil: 'networkidle0' });
    await page.evaluate(() => {
      history.replaceState({}, '', location.pathname + '?autoplay=1');
      location.reload();
    });
    // waitForFunction(__ready) below replaces the fixed 800ms wait
    await page.waitForFunction(() => (window as any).__ready === true, { timeout: 5000 });

    // CDP screencast (60fps target). Track in-flight frame writes so we can
    // drain them after stopScreencast (otherwise last frames lose their ACK
    // and any writeFile error becomes an unhandled rejection).
    const client = await page.target().createCDPSession();
    await client.send('Page.startScreencast', {
      format: 'png', quality: 85,
      maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1,
    });

    let frameIdx = 0;
    const inflight: Promise<void>[] = [];
    await new Promise<void>((resolve) => {
      client.on('Page.screencastFrame', ({ data, sessionId }) => {
        const idx = frameIdx++;
        const filename = path.join(framesDir, `f_${String(idx).padStart(5, '0')}.png`);
        const task = fs.writeFile(filename, Buffer.from(data, 'base64'))
          .then(async () => {
            // ACK AFTER write completes; prevents Chrome from dropping frames
            // we never persisted (Chrome stops emitting new frames if ACK lags).
            await client.send('Page.screencastFrameAck', { sessionId });
          })
          .catch((err) => {
            logger.error({ jobId, idx, err: err instanceof Error ? err.message : String(err) }, 'frame write failed');
            // Still ACK so Chrome doesn't stall — file is lost but pipeline moves on
            return client.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
          });
        inflight.push(task);
      });
      // 总时长 32s（30s + 2s buffer）
      setTimeout(resolve, 32000);
    });

    await client.send('Page.stopScreencast');
    // Drain pending writes/ACKs so last frames actually land
    await Promise.allSettled(inflight);
  } catch (err) {
    throw new Error(`[${jobId}] recording failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (browser) {
      // close() failure shouldn't mask the original recording error, but we log
      // it for visibility. Outer throw wins either way.
      try {
        await browser.close();
      } catch (closeErr) {
        logger.error({ jobId, err: closeErr instanceof Error ? closeErr.message : String(closeErr) }, 'browser.close failed');
      }
    }
  }

  logger.info({ jobId, frames: frameIdx }, 'recording done');
}
