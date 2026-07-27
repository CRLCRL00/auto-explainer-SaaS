import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getEnv } from '@/lib/env';
import {
  isInfrastructureError,
  isOpenAIFallbackAvailable,
  withAnthropicFallback,
} from '@/lib/llm-fallback';

const mockedGetEnv = vi.mocked(getEnv);

describe('isInfrastructureError (v0.5.2)', () => {
  it('1. 5xx (500/502/503/504) is infra', () => {
    expect(isInfrastructureError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isInfrastructureError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isInfrastructureError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isInfrastructureError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('2. timeout / network pattern is infra', () => {
    expect(isInfrastructureError(new Error('Request timeout'))).toBe(true);
    expect(isInfrastructureError(new Error('connect ETIMEDOUT'))).toBe(true);
    expect(isInfrastructureError(new Error('ECONNRESET'))).toBe(true);
    expect(isInfrastructureError(new Error('fetch failed'))).toBe(true);
    expect(isInfrastructureError(new Error('ENOTFOUND api.anthropic.com'))).toBe(true);
    expect(isInfrastructureError(new Error('socket hang up'))).toBe(true);
  });

  it('3. 429 is infra (rate limit at network layer)', () => {
    expect(isInfrastructureError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('4. 4xx logic error (400 / 401 / 403 / 422) is NOT infra', () => {
    expect(isInfrastructureError(new Error('400 Bad Request'))).toBe(false);
    expect(isInfrastructureError(new Error('401 Unauthorized'))).toBe(false);
    expect(isInfrastructureError(new Error('403 Forbidden'))).toBe(false);
    expect(isInfrastructureError(new Error('422 Unprocessable Entity'))).toBe(false);
    expect(isInfrastructureError(new Error('invalid schema: missing field'))).toBe(false);
  });

  it('5. non-Error inputs gracefully return false', () => {
    expect(isInfrastructureError(null)).toBe(false);
    expect(isInfrastructureError(undefined)).toBe(false);
    expect(isInfrastructureError('plain string')).toBe(false);
    expect(isInfrastructureError(42)).toBe(false);
  });
});

describe('isOpenAIFallbackAvailable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('6. returns true when OPENAI_API_KEY set', () => {
    mockedGetEnv.mockReturnValue({ OPENAI_API_KEY: 'sk-test-1234567890' } as never);
    expect(isOpenAIFallbackAvailable()).toBe(true);
  });

  it('7. returns false when OPENAI_API_KEY missing', () => {
    mockedGetEnv.mockReturnValue({} as never);
    expect(isOpenAIFallbackAvailable()).toBe(false);
  });
});

describe('withAnthropicFallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('8. anthropic success → returns anthropic result, does not call openai', async () => {
    mockedGetEnv.mockReturnValue({ OPENAI_API_KEY: 'sk-test-1234567890' } as never);
    const callAnthropic = vi.fn().mockResolvedValue('anthropic-out');
    const callOpenAI = vi.fn();
    const out = await withAnthropicFallback(
      { messages: [{ role: 'user', content: 'x' }] },
      callAnthropic,
      callOpenAI,
    );
    expect(out).toBe('anthropic-out');
    expect(callAnthropic).toHaveBeenCalledTimes(1);
    expect(callOpenAI).not.toHaveBeenCalled();
  });

  it('9. anthropic 5xx + openai key → falls back to openai', async () => {
    mockedGetEnv.mockReturnValue({ OPENAI_API_KEY: 'sk-test-1234567890' } as never);
    const callAnthropic = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    const callOpenAI = vi.fn().mockResolvedValue('openai-out');
    const out = await withAnthropicFallback(
      { messages: [{ role: 'user', content: 'x' }] },
      callAnthropic,
      callOpenAI,
    );
    expect(out).toBe('openai-out');
    expect(callAnthropic).toHaveBeenCalledTimes(1);
    expect(callOpenAI).toHaveBeenCalledTimes(1);
  });

  it('10. anthropic 4xx logic error → NOT fallback, throws original', async () => {
    mockedGetEnv.mockReturnValue({ OPENAI_API_KEY: 'sk-test-1234567890' } as never);
    const callAnthropic = vi.fn().mockRejectedValue(new Error('400 Bad Request: invalid schema'));
    const callOpenAI = vi.fn();
    await expect(
      withAnthropicFallback({ messages: [{ role: 'user', content: 'x' }] }, callAnthropic, callOpenAI),
    ).rejects.toThrow(/400 Bad Request/);
    expect(callOpenAI).not.toHaveBeenCalled();
  });

  it('11. anthropic infra error but no openai key → re-throws (wall hit)', async () => {
    mockedGetEnv.mockReturnValue({} as never); // no OPENAI key
    const callAnthropic = vi.fn().mockRejectedValue(new Error('500 internal error'));
    const callOpenAI = vi.fn();
    await expect(
      withAnthropicFallback({ messages: [{ role: 'user', content: 'x' }] }, callAnthropic, callOpenAI),
    ).rejects.toThrow(/500 internal error/);
    expect(callOpenAI).not.toHaveBeenCalled();
  });

  it('12. anthropic + openai both fail → propagates openai error', async () => {
    mockedGetEnv.mockReturnValue({ OPENAI_API_KEY: 'sk-test-1234567890' } as never);
    const callAnthropic = vi.fn().mockRejectedValue(new Error('503 down'));
    const callOpenAI = vi.fn().mockRejectedValue(new Error('openai rate limit'));
    await expect(
      withAnthropicFallback({ messages: [{ role: 'user', content: 'x' }] }, callAnthropic, callOpenAI),
    ).rejects.toThrow(/openai rate limit/);
  });
});
