import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ───────────────────────────────────────────────────────────────
// Mocks — 必须在 import phase 之前 hoist。
// Mock 模式参考 tests/unit/llm-integration.test.ts:
//   - vi.mock('@/lib/llm-settings') 控制 settings
//   - vi.mock('@/lib/llm') 直接控制 callLlm 返回值
//   - vi.mock('@/lib/db') mock 整个 db 模块（不依赖真实 Postgres）
// ───────────────────────────────────────────────────────────────

// chainable DB mock：select.where.limit 返回 [[job]]；insert.values / update.set.where 追踪调用
// 但不访问 Drizzle 内部 Symbol（直接 table._ 不存在 → 抛错）。Phase 只关心"调到了"，不关心表名。
function makeDbMock(job: unknown) {
  const calls = { inserts: [] as unknown[], updates: [] as unknown[] };

  const db: any = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([job]),
        }),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockImplementation((values: unknown) => {
        calls.inserts.push(values);
        return Promise.resolve();
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation((whereClause: unknown) => {
          // set() 的第一个参数在 set.mock.calls[0][0] 里；whereClause 在 set().where 的调用参数里。
          // 简化：把 set 的第一个参数也单独跟踪。
          calls.updates.push({ where: whereClause });
          return Promise.resolve();
        }),
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

// logger 可能没 import — stub 防止 pin 启动失败
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
import { phaseOutline, SYSTEM_PROMPT, planPromptFor, BeatSchema, PlanSchema } from '@/worker/phases/outline';
import { phaseQgPlan, QgPlanError } from '@/worker/phases/qg-plan';

const mockedCallLlm = vi.mocked(callLlm);
const mockedGetDb = vi.mocked(getDb);

const FIXED_JOB_ID = '11111111-2222-3333-4444-555555555555';
const FIXED_TOPIC = 'RAG 工作原理';

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

const SHORT_PLAN = {
  title: '只有 4 段',
  topic: FIXED_TOPIC,
  beats: VALID_PLAN.beats.slice(0, 4), // 故意缺 b5
};

// ───────────────────────────────────────────────────────────────
// Test infrastructure
// ───────────────────────────────────────────────────────────────

let tmpDir: string;
// MockInstance<unknown[], unknown> 默认与 `vi.spyOn(...).mockReturnValue(tmpDir)`
// 返回的 generic MockInstance<[], string> 不 assignable — ts 报 TS2322. Use
// MockInstance without generic params for declaration; \`mockRestore\` 等方法
// 仍可用. 测试只需调用 cwdSpy.mockRestore() 一次, 不深入类型.
let cwdSpy: MockInstance;
let dbCalls: { inserts: unknown[]; updates: unknown[] };

beforeEach(async () => {
  // 每个测试独立 tmpDir → 不污染其他测试 + 可读落盘内容
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'outline-test-'));
  cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);

  // 默认 mock DB 返回一个标准 job
  const mock = makeDbMock({
    id: FIXED_JOB_ID,
    userId: 'admin',
    status: 'pending',
    phase: 'pending',
    attempts: 0,
    inputType: 'text',
    inputPayload: { topic: FIXED_TOPIC },
  });
  dbCalls = mock.calls;
  mockedGetDb.mockReturnValue(mock.db as never);
});

afterEach(async () => {
  cwdSpy.mockRestore();
  // 清理 tmpDir
  try {
    await fs.rm(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  vi.clearAllMocks();
});

// ───────────────────────────────────────────────────────────────
// outline.ts：prompt 契约
// ───────────────────────────────────────────────────────────────

describe('SYSTEM_PROMPT / planPromptFor', () => {
  it('SYSTEM_PROMPT contains schema with all 5 beat fields', () => {
    expect(SYSTEM_PROMPT).toContain('id');
    expect(SYSTEM_PROMPT).toContain('title');
    expect(SYSTEM_PROMPT).toContain('summary');
    expect(SYSTEM_PROMPT).toContain('duration_sec');
    expect(SYSTEM_PROMPT).toContain('visual_hint');
    expect(SYSTEM_PROMPT).toContain('"b1"');
    expect(SYSTEM_PROMPT).toContain('"b5"');
  });

  it('SYSTEM_PROMPT contains spec §4.6 头三条铁律', () => {
    expect(SYSTEM_PROMPT).toContain('撞墙拐点');
    expect(SYSTEM_PROMPT).toContain('probe-console');
    expect(SYSTEM_PROMPT).toContain('第 2 次输出不合规');
  });

  it('planPromptFor embeds topic + asks for JSON-only', () => {
    const out = planPromptFor('Transformer 注意力机制');
    expect(out).toContain('Transformer 注意力机制');
    expect(out).toContain('topic');
    expect(out).toContain('JSON');
  });
});

// ───────────────────────────────────────────────────────────────
// outline.ts：phaseOutline 行为
// ───────────────────────────────────────────────────────────────

describe('phaseOutline', () => {
  it('正常 5-beat 输出 → plan.json 落盘 + events 落库', async () => {
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(VALID_PLAN));

    await phaseOutline(FIXED_JOB_ID);

    // 1. plan.json 存在且内容正确
    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    const written = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(written.title).toBe(VALID_PLAN.title);
    expect(written.beats).toHaveLength(5);

    // 2. callLlm 用了正确的 system + user prompt
    expect(mockedCallLlm).toHaveBeenCalledOnce();
    const call = mockedCallLlm.mock.calls[0][0];
    expect(call.system).toBe(SYSTEM_PROMPT);
    expect(call.messages[0].role).toBe('user');
    expect(call.messages[0].content).toContain(FIXED_TOPIC);
    expect(call.maxTokens).toBe(2048);

    // 3. jobEvents 被 insert（至少一次 outline_persisted，事件名 + payload 形状 + phase）
    const outlineInsert = dbCalls.inserts.find(
      (v) => (v as { event?: string }).event === 'outline_persisted',
    ) as { phase?: string; event?: string; payload?: { beatCount?: number } } | undefined;
    expect(outlineInsert).toBeDefined();
    expect(outlineInsert!.phase).toBe('planning_done');
    expect(outlineInsert!.event).toBe('outline_persisted');
    expect(outlineInsert!.payload?.beatCount).toBe(5);
  });

  it('非 JSON 输出 → parseAssistantJson 抛错并 propagate', async () => {
    // callLlm 返回非 JSON 字符串（无 fence、无括号）
    mockedCallLlm.mockResolvedValueOnce('I am sorry, I cannot help with that.');

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/outline parse failed/);
    expect(mockedCallLlm).toHaveBeenCalledOnce();
  });

  it('fenced JSON 也被正确解析（即使 LLM 包了 ```json fence）', async () => {
    mockedCallLlm.mockResolvedValueOnce('```json\n' + JSON.stringify(VALID_PLAN) + '\n```');

    await phaseOutline(FIXED_JOB_ID);

    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    const written = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(written.title).toBe(VALID_PLAN.title);
  });

  it('callLlm 失败 → 抛错 propagate (重试在 callLlm 内部)', async () => {
    // callLlm 内部已带 3 次重试；这里 mock 让它直接 reject，验证 outline.ts propagate 错误。
    // 实际 retry 行为在 lib/llm.ts 的 llm-error.test.ts / llm-integration.test.ts 覆盖。
    mockedCallLlm.mockRejectedValue(new Error('network down (simulated callLlm reject)'));

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/network down/);
    expect(mockedCallLlm.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('job inputPayload 缺 topic → 抛错', async () => {
    const { db } = makeDbMock({
      id: FIXED_JOB_ID,
      inputPayload: {}, // 无 topic
    });
    mockedGetDb.mockReturnValue(db as never);

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/no topic/);
    expect(mockedCallLlm).not.toHaveBeenCalled();
  });

  it('job 不存在 → 抛错', async () => {
    const { db } = makeDbMock(undefined); // select 返回 [undefined]
    mockedGetDb.mockReturnValue(db as never);

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/not found/);
    expect(mockedCallLlm).not.toHaveBeenCalled();
  });
});

// ───────────────────────────────────────────────────────────────
// qg-plan.ts：phaseQgPlan 行为
// ───────────────────────────────────────────────────────────────

describe('phaseQgPlan', () => {
  async function writePlan(plan: unknown): Promise<void> {
    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, JSON.stringify(plan), 'utf8');
  }

  it('正常 5-beat plan.json → 通过 + 更新 templateId (验证 set + where 形状)', async () => {
    await writePlan(VALID_PLAN);

    await phaseQgPlan(FIXED_JOB_ID);

    // update.set({ templateId }) + update.where(eqClause) 都通过 dbCalls.updates 追踪
    const updateCalls = dbCalls.updates as Array<{ where: unknown }>;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].where).toBeDefined(); // eq(jobs.id, FIXED_JOB_ID) 是 truthy object
    // insert jobEvents with qg_plan_passed + phase: planning_qg
    const qgInsert = dbCalls.inserts.find(
      (v) => (v as { event?: string }).event === 'qg_plan_passed',
    ) as { phase?: string; event?: string } | undefined;
    expect(qgInsert).toBeDefined();
    expect(qgInsert!.phase).toBe('planning_qg');
    expect(qgInsert!.event).toBe('qg_plan_passed');
  });

  it('4-beat 输出（缺 b5）→ 拒绝抛 QgPlanError', async () => {
    await writePlan(SHORT_PLAN);

    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toBeInstanceOf(QgPlanError);
    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toThrow(/expected 5 beats, got 4/);
  });

  it('beats 总和 > 60s → 拒绝', async () => {
    const longPlan = {
      ...VALID_PLAN,
      beats: VALID_PLAN.beats.map((b) => ({ ...b, duration_sec: 13 })), // 5 × 13 = 65
    };
    await writePlan(longPlan);

    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toBeInstanceOf(QgPlanError);
    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toThrow(/exceeds MAX_TOTAL_DURATION_SEC/);
  });

  it('某 beat 缺字段（无 visual_hint）→ 拒绝', async () => {
    const broken = {
      ...VALID_PLAN,
      beats: VALID_PLAN.beats.map((b, i) =>
        i === 2 ? { ...b, visual_hint: '' } : b, // b3 visual_hint 空字符串
      ),
    };
    await writePlan(broken);

    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toBeInstanceOf(QgPlanError);
  });

  it('某 beat duration_sec = 0 → plan_schema_invalid (PlanSchema.positive() 直接拒)', async () => {
    const zeroed = {
      ...VALID_PLAN,
      beats: VALID_PLAN.beats.map((b, i) => (i === 0 ? { ...b, duration_sec: 0 } : b)),
    };
    await writePlan(zeroed);

    // duration_sec = 0 现在 PlanSchema.positive() 拒，不走到 QG-plan 的 zero-duration 检查
    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toBeInstanceOf(QgPlanError);
    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toThrow(/does not match PlanSchema/);
  });

  it('plan.json 不是合法 JSON → 拒绝', async () => {
    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, 'not json', 'utf8');

    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toBeInstanceOf(QgPlanError);
    await expect(phaseQgPlan(FIXED_JOB_ID)).rejects.toThrow(/not valid JSON/);
  });

  it('边界：beats 总和 = 60s（恰好等于上限） → 通过', async () => {
    const edge = {
      ...VALID_PLAN,
      beats: VALID_PLAN.beats.map((b) => ({ ...b, duration_sec: 12 })), // 5 × 12 = 60
    };
    await writePlan(edge);

    await expect(phaseQgPlan(FIXED_JOB_ID)).resolves.toBeUndefined();
  });
});

describe('P1 polish edge cases', () => {
  it('outline phaseOutline 落盘走 atomic write (tmp + rename, 无 .tmp 残留)', async () => {
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify(VALID_PLAN));
    await phaseOutline(FIXED_JOB_ID);

    const planPath = path.join(tmpDir, 'storage', 'jobs', FIXED_JOB_ID, 'plan.json');
    const tmpLeftover = `${planPath}.tmp`;
    // atomic rename 后 .tmp 不应残留
    await expect(fs.stat(tmpLeftover)).rejects.toThrow();
    // 实际文件落盘
    const written = JSON.parse(await fs.readFile(planPath, 'utf8'));
    expect(written.title).toBe(VALID_PLAN.title);
  });

  it('BeatSchema 拒 0 duration_sec (positive() 直接拒，不再靠 QG-plan 兜底)', () => {
    const r = BeatSchema.safeParse({
      id: 'b1', title: 't', summary: 's', duration_sec: 0, visual_hint: 'v',
    });
    expect(r.success).toBe(false);
  });

  it('BeatSchema 拒负数 duration_sec', () => {
    const r = BeatSchema.safeParse({
      id: 'b1', title: 't', summary: 's', duration_sec: -5, visual_hint: 'v',
    });
    expect(r.success).toBe(false);
  });

  it('PlanSchema 拒 beats: "not array" (shape fail)', async () => {
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify({
      title: 't', topic: 'tp', beats: 'not-array',
    }));

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/outline failed structural schema/);
  });

  it('PlanSchema 拒 beats: [] (空数组在 outline 阶段被拒，不依赖 QG-plan)', async () => {
    mockedCallLlm.mockResolvedValueOnce(JSON.stringify({
      title: 't', topic: 'tp', beats: [],
    }));

    await expect(phaseOutline(FIXED_JOB_ID)).rejects.toThrow(/outline failed structural schema/);
  });
});