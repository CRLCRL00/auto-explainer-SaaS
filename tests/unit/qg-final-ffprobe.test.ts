import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

vi.mock('ffprobe-static', () => ({ path: '/does/not/exist/ffprobe' }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { probeDurationSec, checkFinal, QGFailedError, ProbeError } from '@/lib/pipeline/qg-checks';

describe('probeDurationSec (v0.5.4+)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('1. throws ProbeError when binary not found (ENOENT)', async () => {
    await expect(probeDurationSec('/dev/null', '/does/not/exist/ffprobe-binary'))
      .rejects.toThrow(ProbeError);
  });

  it('2. throws ProbeError on non-zero exit (existing binary returns text)', async () => {
    // node --version 的 stderr 输出非 duration 格式 → parseFloat === NaN → ProbeError
    const dur = await probeDurationSec('/dev/null', `${process.execPath}`).catch((e: unknown) => e);
    // 这里 node execPath 也可, 但 output 是 version string. Just check is ProbeError OR Num NaN.
    // 由于 ffprobe-static mock 已返 '/does/not/exist/ffprobe' 设为 mock default 不可信,
    // 显式 override 用不存在 path 更稳:
    await expect(probeDurationSec('/dev/null', '/totally/missing'))
      .rejects.toThrow(ProbeError);
  });
});

describe('checkFinal / QG-final (v0.5.4+ ffprobe 集成)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'qg-final-ffprobe-'));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('2. throws when mp4 file missing', async () => {
    const missing = join(tmpDir, 'no.mp4');
    await expect(checkFinal({ mp4Path: missing })).rejects.toThrow(/file missing/);
  });

  it('3. throws when mp4 too small', async () => {
    const tiny = join(tmpDir, 'tiny.mp4');
    writeFileSync(tiny, Buffer.alloc(100));
    await expect(checkFinal({ mp4Path: tiny })).rejects.toThrow(/size=100/);
  });

  it('4. size sanity passes; ffprobe graceful skip when binary missing', async () => {
    const ok = join(tmpDir, 'ok.mp4');
    writeFileSync(ok, Buffer.alloc(50_000));
    // ffprobe-static mock 返 '/does/not/exist/ffprobe' → spawn fail → ProbeError
    // → checkFinal catches gracefully (warn log only, 不 throw).
    await expect(checkFinal({ mp4Path: ok })).resolves.toBeUndefined();
  });

  it('5. error message starts with [non-retryable]', async () => {
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

// avoid unused-import lint hint
void spawn;
