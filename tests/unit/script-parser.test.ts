import { describe, it, expect } from 'vitest';
import { parseScriptMd } from '@/worker/phases/html';

describe('parseScriptMd', () => {
  it('parses 5-beat script', () => {
    const md = `
## b1 · 钩子

你以为 RAG 是魔法？错。

## b2 · 定义

RAG = 检索增强生成。`.trim();
    const map = parseScriptMd(md);
    expect(map.get('b1')).toBe('你以为 RAG 是魔法？错。');
    expect(map.get('b2')).toBe('RAG = 检索增强生成。');
  });
});