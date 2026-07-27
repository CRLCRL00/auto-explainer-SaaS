import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { checkPlan, checkScript, checkHtml, LLMQGFailedError } from '@/lib/pipeline/qg-checks-llm';

describe('checkPlan / QG-plan (v0.5.1)', () => {
  it('1. throws when beats.length < 3', () => {
    expect(() => checkPlan({ beats: [{ id: 1, title: 'a', duration_sec: 5 }, { id: 2, title: 'b', duration_sec: 5 }], targetDurationSec: 30 }))
      .toThrow(LLMQGFailedError);
  });

  it('2. throws when beats.length > 12', () => {
    const beats = Array.from({ length: 13 }, (_, i) => ({ id: i, title: `b${i}`, duration_sec: 30 / 13 }));
    expect(() => checkPlan({ beats, targetDurationSec: 30 })).toThrow(/beats.length=13 > 12/);
  });

  it('3. throws when total duration off by > 2s', () => {
    expect(() => checkPlan({
      beats: [
        { id: 1, title: 'a', duration_sec: 5 },
        { id: 2, title: 'b', duration_sec: 5 },
        { id: 3, title: 'c', duration_sec: 5 },
      ],
      targetDurationSec: 100, // ↔ 实际 15s
    })).toThrow(/总时长 15s ≠ target/);
  });

  it('4. throws when beat title empty', () => {
    expect(() => checkPlan({
      beats: [
        { id: 1, title: 'a', duration_sec: 5 },
        { id: 2, title: '', duration_sec: 5 },
        { id: 3, title: 'c', duration_sec: 5 },
      ],
      targetDurationSec: 15,
    })).toThrow(/title empty/);
  });

  it('5. passes when plan is well-formed', () => {
    expect(() => checkPlan({
      beats: [
        { id: 1, title: 'hook', duration_sec: 6 },
        { id: 2, title: 'body', duration_sec: 18 },
        { id: 3, title: 'outro', duration_sec: 6 },
      ],
      targetDurationSec: 30,
    })).not.toThrow();
  });
});

describe('checkScript / QG-script (v0.5.1)', () => {
  it('1. throws when beats.length < 3', () => {
    expect(() => checkScript({
      beats: [{ id: 1, narration: 'x', caption: 'y' }, { id: 2, narration: 'x', caption: 'y' }],
      targetDurationSec: 30,
    })).toThrow();
  });

  it('2. throws when narration empty', () => {
    expect(() => checkScript({
      beats: [
        { id: 1, narration: 'x', caption: 'y' },
        { id: 2, narration: '', caption: 'y' },
        { id: 3, narration: 'x', caption: 'y' },
      ],
      targetDurationSec: 30,
    })).toThrow(/narration empty/);
  });

  it('3. throws when caption empty', () => {
    expect(() => checkScript({
      beats: [
        { id: 1, narration: 'x', caption: 'y' },
        { id: 2, narration: 'x', caption: '' },
        { id: 3, narration: 'x', caption: 'y' },
      ],
      targetDurationSec: 30,
    })).toThrow(/caption empty/);
  });

  it('4. throws when total chars way off target (>±30%)', () => {
    const longBlob = '啊'.repeat(500); // way too many chars
    expect(() => checkScript({
      beats: [
        { id: 1, narration: longBlob, caption: 'a' },
        { id: 2, narration: longBlob, caption: 'a' },
        { id: 3, narration: longBlob, caption: 'a' },
      ],
      targetDurationSec: 30,
    })).toThrow(/总字数/);
  });

  it('5. passes with realistic Chinese script (~ 30s × 3.5 chars/sec = 105 chars)', () => {
    // realistic 30s 中文 TTS narration 总字数约 90~130 (实际播报速率 3~4 字/秒).
    expect(() => checkScript({
      beats: [
        { id: 1, narration: '今天我们来聊聊 RAG,也就是检索增强生成这项最近很火的技术。', caption: 'RAG 是什么' },
        { id: 2, narration: '它通过向量数据库,在生成回答前先把相关文档检索出来,再交给大语言模型,这样能减少幻觉。', caption: 'vector + LLM' },
        { id: 3, narration: '实际部署中需要权衡检索召回率、响应延迟与上下文窗口大小,选择合适的切片策略。', caption: 'trade-off' },
      ],
      targetDurationSec: 30,
    })).not.toThrow();
  });
});

describe('checkHtml / QG-html (v0.5.1)', () => {
  it('1. throws when html empty', () => {
    expect(() => checkHtml({ html: '', beatContainerIdPattern: 'beat-' })).toThrow(/html empty/);
  });

  it('2. throws when beat container pattern missing', () => {
    expect(() => checkHtml({ html: '<div>no beats</div>', beatContainerIdPattern: 'beat-' })).toThrow(/missing beat container/);
  });

  it('3. passes when beat container present', () => {
    expect(() => checkHtml({
      html: '<div id="beat-1">x</div><div id="beat-2">y</div>',
      beatContainerIdPattern: 'beat-',
    })).not.toThrow();
  });
});
