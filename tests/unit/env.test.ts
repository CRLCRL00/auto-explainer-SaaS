import { describe, it, expect } from 'vitest';
import { envSchema } from '@/lib/env';

describe('envSchema', () => {
  it('parses a complete valid env', () => {
    const result = envSchema.parse({
      DATABASE_URL: 'postgres://x',
      REDIS_URL: 'redis://x',
      ANTHROPIC_API_KEY: 'sk-ant-xxxxxxxxxxxxxxxx',
      BASIC_AUTH_USER: 'admin',
      BASIC_AUTH_PASS: 'pw',
      CREATOMATE_API_KEY: 'creato-test-key-1234567890',
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
    });
    expect(result.DATABASE_URL).toBe('postgres://x');
    expect(result.NODE_ENV).toBe('development');
    expect(result.CREATOMATE_API_KEY).toBe('creato-test-key-1234567890');
  });

  it('throws when required key is missing', () => {
    expect(() =>
      envSchema.parse({
        DATABASE_URL: 'postgres://x',
        // missing REDIS_URL, ANTHROPIC_API_KEY etc.
      }),
    ).toThrow();
  });
});