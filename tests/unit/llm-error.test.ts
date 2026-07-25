import { describe, it, expect } from 'vitest';
import { parseAssistantJson } from '@/lib/llm';

describe('parseAssistantJson', () => {
  it('extracts JSON from ```json fences', () => {
    const raw = '```json\n{"a":1,"b":"x"}\n```';
    expect(parseAssistantJson(raw)).toEqual({ a: 1, b: 'x' });
  });

  it('parses raw JSON without fences', () => {
    expect(parseAssistantJson('{"k":"v"}')).toEqual({ k: 'v' });
  });

  it('throws on truly non-JSON input', () => {
    expect(() => parseAssistantJson('hello world')).toThrow();
  });

  it('strips leading prose before JSON block', () => {
    expect(parseAssistantJson('Here is the output:\n```json\n[1,2]\n```')).toEqual([1, 2]);
  });
});
