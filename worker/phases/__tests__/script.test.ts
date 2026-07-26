import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ───────────────────────────────────────────────────────────────
// Mocks — 必须在 import phase 之前 hoist。
// 测试模式参考 worker/phases/__tests__/outline.test.ts。
// ScriptWriter 只调 callLlm + 写文件 + safeRecordEvent（best-effort db insert），
// 所以 lib/db 是 lazy import；mock 整个模块不影响 phase 行为。
// ───────────────────────────────────────────────────────────────

// chainable DB mock：safeRecordEvent 走 getDb().insert().values() → 追踪 insert 调用。
function makeDbMock() {
  const calls = { inserts: [] as unknown[] };

  const db: any = {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: unknown) => {
        calls.inserts.push(values);
        return Promise.resolve();
      }),
    }),
  };

  return { db, calls };
}

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(),
}));

vi.mock('@/lib/llm', async () => {
  const actual = await vi.importActual<typeof import('@/lib/llm')>('@/lib/llm');
  return {
    ...actual,
    callLlm: vi.fn(),
  };
});

// logger stub 防止 pino 启动失败
vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ───────────────────────────────────────────────────────────────
// Imports under test
// ───────────────────────────────────────────────────────────────

import { callLlm } from '@/lib/llm';
import { getDb } from '@/lib/db';
import {
  phaseScript,
  SYSTEM_PROMPT,
  scriptPromptFor,
  scriptPathFor,
  ScriptSchema,
} from '@/worker/phases/script';

const mockedCallLlm = vi.mocked(callLlm);
const mockedGetDb = vi.mocked(getDb);

const FIXED_JOB_ID = '11111111-2222-3333-4444-555555555555';
const FIXED_TOPIC = 'RAG 工作原理';

// flat schema plan (与 outline.ts 产出的 plan.json 一致)。
const VALID_PLAN = {
  title: 'RAG 原理 90 秒搞懂',
  topic: FIXED_TOPIC,
  beats: [
    { id: 'b1', title: '钩子',     summary: '你以为 LLM 答不出来？', duration_sec: 6, visual_hint: '红色 80px 黑底' },
    { id: 'b2', title: '定义',     summary: 'RAG = 检索 + 生成',   duration_sec: 6, visual_hint: '蓝色大字号' },
    { id: 'b3', title: '数字对比', summary: '0.3s vs 30s',         duration_sec: 6, visual_hint: '紫色 280px 背景' },
    { id: 'b4', title: '真实例子', summary: '客服查订单',           duration_sec: 6, visual_hint: '橙色卡片' },
    { id: 'b5', title: '收尾',     summary: '一句话总结',           duration_sec: 6, visual_hint: '绿色关键字' },
  ],
};

// 合法 ScriptJson 输出（沿用 plan beats + 三文本字段）
const VALID_SCRIPT = {
  title: VALID_PLAN.title,
  topic: VALID_PLAN.topic,
  beats: VALID_PLAN.beats.map((b, i) => ({
    ...b,
    narration: `${b.title}段口播稿第 ${i + 1} 段，约 30 字内念完。`,
    caption: `${b.title}字幕短句`,
    tts_text: `${b.title}段口播稿第 ${i + 1} 段念完`,
  })),
};

// ───────────────────────────────────────────────────────────────
// Test infrastructure
// ───────────────────────────────────────────────────────────────

let tmpDir: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;
let dbCalls: { inserts: unknown[] };

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'script-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  const mock = makeDbMock();
  dbCalls = mock.calls;
  mockedGetDb.mockReturnValue(mock.db as never);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.clearAllMocks();
});

// 写 plan.json helper — 模拟 outline + QG-plan 已经跑过的状态
async function writePlan(plan: unknown): Promise<void> {
  const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan), 'utf8');
}

// ───────────────────────────────────────────────────────────────
// Prompt 契约
// ───────────────────────────────────────────────────────────────

describe('SYSTEM_PROMPT / scriptPromptFor', () => {
  it('SYSTEM_PROMPT contains spec §4.6 头三条铁律', () => {
    expect(SYSTEM_PROMPT).toContain('撞墙拐点');
    expect(SYSTEM_PROMPT).toContain('probe-console');
    expect(SYSTEM_PROMPT).toContain('第 2 次输出不合规');
  });

  it('SYSTEM_PROMPT declares all three text fields (narration / caption / tts_text)', () => {
    expect(SYSTEM_PROMPT).toContain('narration');
    expect(SYSTEM_PROMPT).toContain('caption');
    expect(SYSTEM_PROMPT).toContain('tts_text');
  });

  it('SYSTEM_PROMPT declares 6-second / 30-character rule for narration', () => {
    expect(SYSTEM_PROMPT).toContain('30');
    // 提到时长 6 秒
    expect(SYSTEM_PROMPT).toContain('6 秒');
  });

  it('scriptPromptFor embeds plan title + topic + asks for JSON-only', () => {
    const out = scriptPromptFor(VALID_PLAN);
    expect(out).toContain(VALID_PLAN.title);
    expect(out).toContain(VALID_PLAN.topic);
    expect(out).toContain('JSON');
    // 沿用 beat id / title (consumer 必须 flat schema 化)
    expect(out).toContain('b1');
    expect(out).toContain('钩子');
    // visual_hint 透传给 LLM
    expect(out).toContain('红色 80px 黑底');
  });
});

// ───────────────────────────────────────────────────────────────
// phaseScript 行为
// ───────────────────────────────────────────────────────────────

describe('phaseScript', () => {
  it('正常 5-beat 输出 → script.json 落盘 + events 落库', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

    await phaseScript(FIXED_JOB_ID);

    // 1. script.json 落盘
    const scriptPath = scriptPathFor(FIXED_JOB_ID);
    const written = JSON.parse(await fs.readFile(scriptPath, 'utf8'));
    expect(written.title).toBe(VALID_SCRIPT.title);
    expect(written.topic).toBe(VALID_SCRIPT.topic);
    expect(written.beats).toHaveLength(5);
    // 每个 beat 都有三文本字段
    written.beats.forEach((b: { narration: string; caption: string; tts_text: string }) => {
      expect(b.narration).toBeTruthy();
      expect(b.caption).toBeTruthy();
      expect(b.tts_text).toBeTruthy();
    });

    // 2. callLlm 用了正确的 system + user prompt
    expect(mockedCallLlm).toHaveBeenCalledOnce();
    const call = mockedCallLlm.mock.calls[0][0];
    expect(call.system).toBe(SYSTEM_PROMPT);
    expect(call.messages[0].role).toBe('user');
    expect(call.messages[0].content).toContain(VALID_PLAN.title);
    expect(call.messages[0].content).toContain('b1');
    expect(call.maxTokens).toBe(4096);

    // 3. jobEvents 至少有一次 script_persisted，phase = script_ready
    const persisted = dbCalls.inserts.find(
      (v) => (v as { event?: string }).event === 'script_persisted',
    ) as { phase?: string; event?: string; payload?: { beatCount?: number } } | undefined;
    expect(persisted).toBeDefined();
    expect(persisted!.phase).toBe('script_ready');
    expect(persisted!.event).toBe('script_persisted');
    expect(persisted!.payload?.beatCount).toBe(5);
  });

  it('fenced JSON 也被正确解析（即使 LLM 包了 ```json fence）', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockResolvedValueOnce('```json\n' + JSON.stringify(VALID_SCRIPT) + '\n```');

    await phaseScript(FIXED_JOB_ID);

    const scriptPath = scriptPathFor(FIXED_JOB_ID);
    const written = JSON.parse(await fs.readFile(scriptPath, 'utf8'));
    expect(written.beats).toHaveLength(5);
    expect(written.beats[0].id).toBe('b1');
  });

  it('非 JSON 输出 → parseAssistantJson 抛错并 propagate', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockResolvedValueOnce('I cannot help with that, sorry.');

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/script parse failed/);
    expect(mockedCallLlm).toHaveBeenCalledOnce();
    // parse_failed 事件应该被记录（best-effort db insert）
    const failedEvent = dbCalls.inserts.find(
      (v) => (v as { event?: string }).event === 'script_parse_failed',
    );
    expect(failedEvent).toBeDefined();
  });

  it('callLlm 失败 → 抛错 propagate (重试在 callLlm 内部)', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockRejectedValue(new Error('network down (simulated callLlm reject)'));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/network down/);
    expect(mockedCallLlm.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('plan.json 不存在 → 抛错 (file-not-found)', async () => {
    // 不 writePlan → 文件不存在
    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/plan\.json not readable/);
    expect(mockedCallLlm).not.toHaveBeenCalled();
  });

  it('plan.json 不是合法 JSON → 抛错', async () => {
    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, 'not json', 'utf8');

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/plan\.json not valid JSON/);
    expect(mockedCallLlm).not.toHaveBeenCalled();
  });

  it('plan.json Zod 验证失败 → 抛错 (beats 缺字段)', async () => {
    // beats 缺 visual_hint → PlanSchema 拒
    const broken = {
      ...VALID_PLAN,
      beats: VALID_PLAN.beats.map((b) => ({ ...b, visual_hint: '' })),
    };
    await writePlan(broken);

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/does not match PlanSchema/);
    expect(mockedCallLlm).not.toHaveBeenCalled();
  });

  it('LLM 输出 Zod 验证失败（narration 缺）→ 抛错 + 记录 script_schema_failed', async () => {
    await writePlan(VALID_PLAN);
    const brokenScript = {
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b) => ({ ...b, narration: '' })), // 空字符串
    };
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(brokenScript));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/script failed structural schema/);
    // schema_failed 事件被记录
    const failedEvent = dbCalls.inserts.find(
      (v) => (v as { event?: string }).event === 'script_schema_failed',
    );
    expect(failedEvent).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────
// Schema edge cases
// ───────────────────────────────────────────────────────────────

describe('ScriptSchema', () => {
  it('narration / caption / tts_text 都必填且非空', () => {
    const r = ScriptSchema.safeParse({
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b) => ({ ...b, narration: '' })),
    });
    expect(r.success).toBe(false);
  });

  it('beats 数量 ≠ 5 → length(5) 严格拒', () => {
    const four = { ...VALID_SCRIPT, beats: VALID_SCRIPT.beats.slice(0, 4) };
    const six = { ...VALID_SCRIPT, beats: [...VALID_SCRIPT.beats, { ...VALID_SCRIPT.beats[0], id: 'b6' }] };
    expect(ScriptSchema.safeParse(four).success).toBe(false);
    expect(ScriptSchema.safeParse(six).success).toBe(false);
  });

  it('narration 超过 60 字 → max(60) 拒', () => {
    const long = '啊'.repeat(61);
    const r = ScriptSchema.safeParse({
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b, i) => (i === 0 ? { ...b, narration: long } : b)),
    });
    expect(r.success).toBe(false);
  });

  it('caption 超过 40 字 → max(40) 拒', () => {
    const long = '啊'.repeat(41);
    const r = ScriptSchema.safeParse({
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b, i) => (i === 0 ? { ...b, caption: long } : b)),
    });
    expect(r.success).toBe(false);
  });

  it('plan beats 的 flat 字段都被 ScriptBeatSchema 继承 (id/title/summary/duration_sec/visual_hint)', async () => {
    // 故意把 visual_hint 拿掉 → ScriptBeatSchema (BeatSchema.extend) 应该拒
    await writePlan(VALID_PLAN);
    const broken = {
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b) => {
        const { visual_hint: _drop, ...rest } = b;
        return rest;
      }),
    };
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(broken));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/script failed structural schema/);
  });
});

// ───────────────────────────────────────────────────────────────
// Atomic write
// ───────────────────────────────────────────────────────────────

describe('P1 polish: script phaseScript 落盘走 atomic write', () => {
  it('落盘走 tmp + rename, 无 .tmp 残留', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

    await phaseScript(FIXED_JOB_ID);

    const scriptPath = scriptPathFor(FIXED_JOB_ID);
    const tmpLeftover = `${scriptPath}.tmp`;
    // atomic rename 后 .tmp 不应残留
    await expect(fs.stat(tmpLeftover)).rejects.toThrow();
    // 实际文件落盘
    const written = JSON.parse(await fs.readFile(scriptPath, 'utf8'));
    expect(written.title).toBe(VALID_SCRIPT.title);
  });
});

describe('P0-2 fix: script 严格沿用 plan 字段 (detectPlanDrift)', () => {
  it('LLM 改了 title → 抛错 script_plan_drift', async () => {
    await writePlan(VALID_PLAN);
    const drifted = {
      ...VALID_SCRIPT,
      title: 'LLM 私自改的标题', // 与 VALID_PLAN.title 不同
    };
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(drifted));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/drifted from plan.*title drift/);
  });

  it('LLM 改了 beat[0].duration_sec → 抛错', async () => {
    await writePlan(VALID_PLAN);
    const drifted = {
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b, i) => (i === 0 ? { ...b, duration_sec: 999 } : b)),
    };
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(drifted));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/beat\[0\]\.duration_sec drift/);
  });

  it('LLM 改了 beat[2].visual_hint → 抛错', async () => {
    await writePlan(VALID_PLAN);
    const drifted = {
      ...VALID_SCRIPT,
      beats: VALID_SCRIPT.beats.map((b, i) => (i === 2 ? { ...b, visual_hint: 'LLM 私自改的视觉' } : b)),
    };
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(drifted));

    await expect(phaseScript(FIXED_JOB_ID)).rejects.toThrow(/beat\[2\]\.visual_hint drift/);
  });

  it('LLM 输出严格沿用 plan → 通过', async () => {
    await writePlan(VALID_PLAN);
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(VALID_SCRIPT));

    await expect(phaseScript(FIXED_JOB_ID)).resolves.toBeUndefined();
  });
});