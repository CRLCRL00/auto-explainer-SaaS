import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

// vi.hoisted: 必须用 pattern 让 vi.mock factory 能 reference 这些 mock 句柄
// (vitest 1.6 严: vi.mock factory 不许读 top-level const, 必须 hoist-refs).
//
// 关键: 所有 mock chain (vi.fn().mockReturnValue(x)) 必须在 factory **内部**创建.
// 出厂后再赋值 (e.g. refs.foo = vi.fn()) 可能在 mock factory 调用时
// 拿到的还是初始未赋值的 vi.fn() —— 引发 "undefined.values" 类运行时错。
const refs = vi.hoisted(() => {
  const insertValues = vi.fn().mockResolvedValue(undefined);
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const dbInsert = vi.fn().mockReturnValue({ values: insertValues });
  const dbUpdate = vi.fn().mockReturnValue({ set: updateSet });
  return {
    // SDK mocks
    clientRender: vi.fn(),
    sourceCtor: vi.fn(),
    imageCtor: vi.fn(),
    textCtor: vi.fn(),
    audioCtor: vi.fn(),
    shadowCtor: vi.fn(),
    // DB mocks
    insertValues,
    updateWhere,
    updateSet,
    dbInsert,
    dbUpdate,
  };
});

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() },
}));
vi.mock('creatomate', () => ({
  default: {
    Client: vi.fn().mockImplementation(() => ({ render: refs.clientRender })),
    Source: vi.fn().mockImplementation((p: unknown) => {
      refs.sourceCtor(p);
      return { properties: p };
    }),
    Image: vi.fn().mockImplementation((p: unknown) => {
      refs.imageCtor(p);
      return p;
    }),
    Text: vi.fn().mockImplementation((p: unknown) => {
      refs.textCtor(p);
      return p;
    }),
    Audio: vi.fn().mockImplementation((p: unknown) => {
      refs.audioCtor(p);
      return p;
    }),
    Shadow: vi.fn().mockImplementation((p: unknown) => {
      refs.shadowCtor(p);
      return p;
    }),
  },
}));
vi.mock('@/lib/db', () => ({
  getDb: vi.fn().mockReturnValue({
    insert: refs.dbInsert,
    update: refs.dbUpdate,
  }),
}));
vi.mock('@/lib/schema', () => ({ jobArtifacts: {}, jobs: {} }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn((a: unknown, b: unknown) => ({ a, b })) }));
// TTS pipeline: 已有 3 tests 验证 synthesizeToBuffer 自身行为. 这里 happy path
// 没配 Azure env 时不调用 TTS — 不需 mock. case 5 调 TTS 时 mock.
vi.mock('@/lib/job-events', async () => {
  const actual = await vi.importActual<typeof import('@/lib/job-events')>('@/lib/job-events');
  return {
    ...actual,
    safeRecordEvent: vi.fn().mockResolvedValue(undefined),
  };
});

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

async function writeFakeScript(dir: string, script: { title: string; beats: Array<{ caption: string; tts_text: string }> }) {
  await fs.writeFile(path.join(dir, 'script.json'), JSON.stringify(script), 'utf8');
}

describe('phaseEncodeCreatomate (P0 全量)', () => {
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

  it('1. happy path: render succeeded → download → write artifact → cleanup', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    refs.clientRender.mockResolvedValue([
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
    expect(refs.clientRender).toHaveBeenCalledTimes(1);

    expect(refs.sourceCtor).toHaveBeenCalledTimes(1);
    const sourceArg = refs.sourceCtor.mock.calls[0][0] as {
      outputFormat: string;
      width: number;
      height: number;
      duration: number;
      frameRate: number;
      elements: Array<{ source?: string; fit?: string; text?: string }>;
    };
    expect(sourceArg.outputFormat).toBe('mp4');
    expect(sourceArg.width).toBe(1080);
    expect(sourceArg.height).toBe(1920);
    expect(sourceArg.duration).toBe(30);
    expect(sourceArg.frameRate).toBe(30);
    expect(Array.isArray(sourceArg.elements)).toBe(true);

    // 无 script.json + 无 Azure key = 仅 Image element
    expect(sourceArg.elements).toHaveLength(1);
    const imgArg = sourceArg.elements[0];
    expect(imgArg.source).toMatch(/^file:\/\/.*f_00000\.png$/);
    expect(imgArg.fit).toBe('cover');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith('https://cdn.creatomate.com/renders/r-123.mp4');
    const outPath = path.join(tmpJobDir, 'video.mp4');
    const written = await fs.readFile(outPath);
    expect(written.toString('utf8')).toBe('fake-mp4-binary-data');
    expect(refs.dbInsert).toHaveBeenCalledTimes(1);
    expect(refs.insertValues).toHaveBeenCalledTimes(1);
    expect(refs.dbUpdate).toHaveBeenCalledTimes(1);

    await expect(fs.stat(path.join(tmpJobDir, 'frames'))).rejects.toThrow();
  });

  it('2. script.json present + 3 captions → Image + 3 Text elements (no audio)', async () => {
    await writeFakeScript(tmpJobDir, {
      title: '测试标题',
      beats: [
        { caption: '第一句', tts_text: '第一句 TTS' },
        { caption: '第二句', tts_text: '第二句 TTS' },
        { caption: '第三句', tts_text: '第三句 TTS' },
      ],
    });
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    refs.clientRender.mockResolvedValue([
      { id: 'r-x', status: 'succeeded', url: 'https://cdn/x.mp4', outputFormat: 'mp4', renderScale: 1 },
    ]);
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => new ArrayBuffer(8),
    });

    await phaseEncodeCreatomate('test-job-captions', { jobDir: tmpJobDir });

    const sourceArg = refs.sourceCtor.mock.calls[0][0] as { elements: Array<{ text?: string; source?: string }> };
    expect(sourceArg.elements.length).toBeGreaterThanOrEqual(4); // 1 Image + 3 Text
    expect(refs.textCtor).toHaveBeenCalledTimes(3);
    expect(refs.imageCtor).toHaveBeenCalledTimes(1);
    expect(refs.audioCtor).not.toHaveBeenCalled(); // 无 Azure key → 不加 Audio
    const texts = refs.textCtor.mock.calls.map((c) => c[0] as { text: string });
    expect(texts.map((t) => t.text)).toEqual(['第一句', '第二句', '第三句']);
  });

  it('3. throws when CREATOMATE_API_KEY missing', async () => {
    mockedGetEnv.mockReturnValue({} as never);
    await expect(
      phaseEncodeCreatomate('test-job-2', { jobDir: tmpJobDir }),
    ).rejects.toThrow(/CREATOMATE_API_KEY missing or too short/);
    expect(MockedClientCtor).not.toHaveBeenCalled();
    expect(refs.dbInsert).not.toHaveBeenCalled();
  });

  it('4. throws when no PNG frames in frames dir', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    await fs.rm(path.join(tmpJobDir, 'frames'), { recursive: true, force: true });
    await fs.mkdir(path.join(tmpJobDir, 'frames'), { recursive: true });
    await expect(
      phaseEncodeCreatomate('test-job-3', { jobDir: tmpJobDir }),
    ).rejects.toThrow(/no PNG frames/);
    expect(MockedClientCtor).not.toHaveBeenCalled();
  });

  it('5. throws when Creatomate render status is not "succeeded"', async () => {
    mockedGetEnv.mockReturnValue({ CREATOMATE_API_KEY: 'creato-key-1234567890' } as never);
    refs.clientRender.mockResolvedValue([
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
    expect(refs.dbInsert).not.toHaveBeenCalled();
  });
});
