import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkRender, checkFinal, QGFailedError } from '@/lib/pipeline/qg-checks';

describe('checkRender / QG-render (v0.5)', () => {
  it('1. throws when browserCrashed=true', async () => {
    await expect(checkRender({ realFps: 30, frameCount: 900, browserCrashed: true }))
      .rejects.toThrow(QGFailedError);
    await expect(checkRender({ realFps: 30, frameCount: 900, browserCrashed: true }))
      .rejects.toThrow(/browser crashed/);
  });

  it('2. throws when realFps below PRD threshold (12)', async () => {
    await expect(checkRender({ realFps: 8, frameCount: 900, browserCrashed: false }))
      .rejects.toThrow(/realFps=8/);
  });

  it('3. throws when frameCount suspiciously low (early crash)', async () => {
    await expect(checkRender({ realFps: 30, frameCount: 50, browserCrashed: false }))
      .rejects.toThrow(/frameCount/);
  });

  it('4. passes when all checks within bounds', async () => {
    await expect(checkRender({ realFps: 30, frameCount: 900, browserCrashed: false }))
      .resolves.toBeUndefined();
  });
});

describe('checkFinal / QG-final (v0.5)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'qg-final-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('5. throws when mp4 file missing', async () => {
    const missing = join(tmpDir, 'no-such.mp4');
    await expect(checkFinal({ mp4Path: missing })).rejects.toThrow(/file missing/);
  });

  it('6. throws when mp4 file too small (<10KB)', async () => {
    const tiny = join(tmpDir, 'tiny.mp4');
    writeFileSync(tiny, Buffer.alloc(100)); // 100 bytes
    await expect(checkFinal({ mp4Path: tiny })).rejects.toThrow(/size=100/);
  });

  it('7. passes with realistic file size', async () => {
    const ok = join(tmpDir, 'ok.mp4');
    writeFileSync(ok, Buffer.alloc(50_000)); // 50 KB
    await expect(checkFinal({ mp4Path: ok })).resolves.toBeUndefined();
  });

  it('8. error message starts with [non-retryable] — signals wall-hit to retry helper', async () => {
    const tiny = join(tmpDir, 'tiny.mp4');
    writeFileSync(tiny, Buffer.alloc(0));
    let thrown: unknown = null;
    try {
      await checkFinal({ mp4Path: tiny });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QGFailedError);
    expect((thrown as Error).message.startsWith('[non-retryable]')).toBe(true);
  });
});
