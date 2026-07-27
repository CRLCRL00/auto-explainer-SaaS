import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));

const mockClientRender = vi.fn();
const mockSourceCtor = vi.fn();
const mockImageCtor = vi.fn();

vi.mock('creatomate', () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({ render: mockClientRender })),
    Source: vi.fn().mockImplementation((p: unknown) => {
      mockSourceCtor(p);
      return { properties: p };
    }),
    Image: vi.fn().mockImplementation((p: unknown) => {
      mockImageCtor(p);
      return p;
    }),
  },
}));

const insertValues = vi.fn().mockResolvedValue(undefined);
const updateWhere = vi.fn().mockResolvedValue(undefined);
const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
const dbInsert = vi.fn().mockReturnValue({ values: insertValues });
const dbUpdate = vi.fn().mockReturnValue({ set: updateSet });
vi.mock('@/lib/db', () => ({
  getDb: vi.fn().mockReturnValue({ insert: dbInsert, update: dbUpdate }),
}));
vi.mock('@/lib/schema', () => ({ jobArtifacts: {}, jobs: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((a: unknown, b: unknown) => ({ a, b })) }));

import { getEnv } from '@/lib/env';
import Creatomate from 'creatomate';
import { phaseEncodeCreatomate } from '@/worker/phases/encode-creatomate';

const mockedGetEnv = vi.mocked(getEnv);
const MockedClientCtor = vi.mocked(Creatomate.Client);

let tmpJobDir: string;
let mockFetch: ReturnType<typeof vi.fn>;

async function writeFakeFrames(dir: string, names: string[]) {
  await fs.mkdir(dir, { recursive: true });
  for (const n of names) await fs.writeFile(path.join(dir, n), 'fake-png-bytes');
}

describe('phaseEncodeCreatomate (P0 POC)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpJobDir = path.join(
      os.tmpdir(),
      `encode-creatomate-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await writeFakeFrames(path.join(tmpJobDir, 'frames'), ['f_00000.png', 'f_00001.png', 'f_00002.png']);
    mockFetch = vi.fn();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  it('1. happy path: render succeeded → download → write artifact → cleanup frames', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    mockClientRender.mockResolvedValue([
      {
        id: 'r-123',
        status: 'succeeded',
        url: 'https://cdn.creatomate.com/renders/r-123.mp4',
        outputFormat: 'mp4',
        renderScale: 1,
      },
    ]);
    const fakeMp4 = Buffer.from('fake-mp4-binary-data');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => fakeMp4.buffer.slice(fakeMp4.byteOffset, fakeMp4.byteOffset + fakeMp4.byteLength),
    });

    await phaseEncodeCreatomate('test-job-1', { jobDir: tmpJobDir });

    expect(MockedClientCtor).toHaveBeenCalledWith('creato-key-1234567890');
    expect(mockClientRender).toHaveBeenCalledTimes(1);

    // Source 构造器收到 mp4 + 1080x1920 + 30s duration + 30fps
    expect(mockSourceCtor).toHaveBeenCalledTimes(1);
    const sourceArg = mockSourceCtor.mock.calls[0][0] as {
      outputFormat: string;
      width: number;
      height: number;
      duration: number;
      frameRate: number;
      elements: Array<{ source: string; fit: string }>;
    };
    expect(sourceArg.outputFormat).toBe('mp4');
    expect(sourceArg.width).toBe(1080);
    expect(sourceArg.height).toBe(1920);
    expect(sourceArg.duration).toBe(30);
    expect(sourceArg.frameRate).toBe(30);
    expect(Array.isArray(sourceArg.elements)).toBe(true);
    expect(sourceArg.elements).toHaveLength(1);

    // Image element 引用第一张 PNG + cover fit
    const imgArg = sourceArg.elements[0];
    expect(imgArg.source).toMatch(/^file:\/\/.*f_00000\.png$/);
    expect(imgArg.fit).toBe('cover');

    // fetch render.url + 写 mp4 + insert artifact + update jobs
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://cdn.creatomate.com/renders/r-123.mp4');
    const outPath = path.join(tmpJobDir, 'video.mp4');
    const written = await fs.readFile(outPath);
    expect(written.toString('utf8')).toBe('fake-mp4-binary-data');
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(insertValues).toHaveBeenCalledTimes(1);
    expect(dbUpdate).toHaveBeenCalledTimes(1);

    // frames dir 应被清理
    await expect(fs.stat(path.join(tmpJobDir, 'frames'))).rejects.toThrow();
  });

  it('2. throws when CREATOMATE_API_KEY missing', async () => {
    mockedGetEnv.mockReturnValue({} as never);
    await expect(
      phaseEncodeCreatomate('test-job-2', { jobDir: tmpJobDir }),
    ).rejects.toThrow(/CREATOMATE_API_KEY not configured/);
    expect(MockedClientCtor).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('3. throws when no PNG frames in frames dir', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    // 清空 frames
    await fs.rm(path.join(tmpJobDir, 'frames'), { recursive: true, force: true });
    await fs.mkdir(path.join(tmpJobDir, 'frames'), { recursive: true });
    await expect(
      phaseEncodeCreatomate('test-job-3', { jobDir: tmpJobDir }),
    ).rejects.toThrow(/no PNG frames/);
    expect(MockedClientCtor).not.toHaveBeenCalled();
  });

  it('4. throws when Creatomate render status is not "succeeded"', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    mockClientRender.mockResolvedValue([
      {
        id: 'r-456',
        status: 'failed',
        url: 'https://cdn.creatomate.com/renders/r-456.mp4',
        errorMessage: 'creatomate internal: bad source url',
        outputFormat: 'mp4',
        renderScale: 1,
      },
    ]);
    await expect(
      phaseEncodeCreatomate('test-job-4', { jobDir: tmpJobDir }),
    ).rejects.toThrow(/Creatomate render failed: status=failed/);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(dbInsert).not.toHaveBeenCalled();
  });
});
