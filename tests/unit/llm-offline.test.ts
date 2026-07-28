// v0.6.1 R5 unit tests for lib/llm-offline.ts (cached template fallback).
//
// 这层只测 pure helper 函数 — 'cachedPlan(topic)' / 'cachedScript(plan, topic)' /
// 'detectLlmRole(system)'. callLlm 的'主路径 + all fail → offline' 分支 由
// tests/integration/lib-llm-fallback.test.ts 覆盖 (通过 LLM_OFFLINE_FALLBACK=1
// env 开关).

import { describe, it, expect } from 'vitest';
import { cachedPlan, cachedScript, detectLlmRole } from '@/lib/llm-offline';

describe('cachedPlan (v0.6.1 R5, spec §4.3 LLM offline mode)', () => {
  it('1. topic 注入 5 个 beat — 每 beat 必填字段 (id/title/summary/duration_sec/visual_hint)', () => {
    const raw = cachedPlan('RAG 检索原理');
    const parsed = JSON.parse(raw) as {
      title: string;
      topic: string;
      beats: Array<{ id: string; title: string; summary: string; duration_sec: number; visual_hint: string }>;
    };
    expect(parsed.title.length).toBeGreaterThan(0);
    expect(parsed.topic).toBe('RAG 检索原理');
    expect(parsed.beats).toHaveLength(5);
    for (const b of parsed.beats) {
      expect(b.id).toMatch(/^b[1-5]$/);
      expect(b.title).toBeTruthy();
      expect(b.summary).toContain('RAG 检索原理');
      expect(b.duration_sec).toBe(6);
      expect(b.visual_hint).toBeTruthy();
    }
  });

  it('2. 空 topic → 默认 title + topic fallback 不破 schema', () => {
    const raw = cachedPlan('');
    const parsed = JSON.parse(raw) as { title: string; topic: string; beats: unknown[] };
    expect(parsed.title).toBe('Auto-Explainer');
    // 空 topic 也 fallback 到 'Auto-Explainer' — 避免后续 parse 拿不到非空 string
    expect(parsed.topic).toBe('Auto-Explainer');
    expect(parsed.beats).toHaveLength(5);
  });

  it('3. 长 topic (>60 char) 截断避免 plan.json 异常膨胀', () => {
    const long = '啊'.repeat(200);
    const raw = cachedPlan(long);
    const parsed = JSON.parse(raw) as { topic: string };
    expect(parsed.topic.length).toBeLessThanOrEqual(60);
  });

  it('4. XSS-style input sanitized (闭引/<>) 不破 schema', () => {
    const raw = cachedPlan('<script>alert("xss")</script>');
    const parsed = JSON.parse(raw) as { topic: string };
    expect(parsed.topic).not.toMatch(/<script>/i);
    expect(parsed.topic).not.toMatch(/[<>&"']/);
  });
});

describe('cachedScript (v0.6.1 R5)', () => {
  it('5. 含 plan object 输入 → 复用 plan 的 title 与 beats', () => {
    const plan = {
      title: 'RAG 原理',
      beats: [
        { id: 'b1', title: '钩子', summary: '反常识' },
        { id: 'b2', title: '定义', summary: '核心' },
        { id: 'b3', title: '数字', summary: '对比' },
        { id: 'b4', title: '例子', summary: '真实' },
        { id: 'b5', title: '收尾', summary: '本质' },
      ],
    };
    const raw = cachedScript(plan, 'RAG 原理');
    const parsed = JSON.parse(raw) as {
      title: string;
      beats: Array<{ id: string; narration: string; caption: string; tts_text: string }>;
    };
    expect(parsed.title).toBe('RAG 原理');
    expect(parsed.beats).toHaveLength(5);
    for (const b of parsed.beats) {
      expect(b.narration).toBeTruthy();
      expect(b.caption.length).toBeLessThanOrEqual(40); // caption.max(40) 守 schema
      expect(b.tts_text).toBeTruthy();
    }
  });

  it('6. 缺 beats (parse 失败) → 用默认 5 beat fallback', () => {
    const raw = cachedScript('not json {', 'fallback topic');
    const parsed = JSON.parse(raw) as { beats: Array<{ id: string }> };
    expect(parsed.beats).toHaveLength(5);
  });

  it('7. beats 越界 (<3 或 >12) → 也用默认 5 beat', () => {
    const bad = { title: 'X', beats: [{ id: 'b1', title: 't', summary: 's' }] };
    const raw = cachedScript(bad, 'X');
    const parsed = JSON.parse(raw) as { beats: unknown[] };
    expect(parsed.beats).toHaveLength(5);
  });
});

describe('detectLlmRole (v0.6.1 R5)', () => {
  it('8. system 含 narration/caption → script', () => {
    expect(detectLlmRole('你正在为... 写每段口播稿。 naration + caption')).toBe('script');
  });
  it('9. system 含 beats/visual_hint → plan', () => {
    expect(detectLlmRole('你正在为... 生成内容大纲。 beats + visual_hint')).toBe('plan');
  });
  it('10. undefined / 陌生 system → generic', () => {
    expect(detectLlmRole(undefined)).toBe('generic');
    expect(detectLlmRole('some prompt without markers')).toBe('generic');
  });
});
