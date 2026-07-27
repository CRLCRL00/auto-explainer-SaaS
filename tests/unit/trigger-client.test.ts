import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/env', () => ({ getEnv: vi.fn() }));

import { getEnv } from '@/lib/env';
import { resolveTriggerConfig, getTriggerSdk } from '@/lib/trigger';

const mockedGetEnv = vi.mocked(getEnv);

describe('resolveTriggerConfig (P1 PR1 — env gating only)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('1. throws when RUN_TRIGGER_DEV !== "1" (default off)', () => {
    mockedGetEnv.mockReturnValue({ RUN_TRIGGER_DEV: '0' } as never);
    expect(() => resolveTriggerConfig()).toThrow(/RUN_TRIGGER_DEV=0/);
  });

  it('2. throws when TRIGGER_PROJECT_REF missing', () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
    } as never);
    expect(() => resolveTriggerConfig()).toThrow(/TRIGGER_PROJECT_REF not set/);
  });

  it('3. throws when TRIGGER_SECRET_KEY missing or too short', () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_API_URL: 'http://trigger-web:3030',
    } as never);
    expect(() => resolveTriggerConfig()).toThrow(/TRIGGER_SECRET_KEY/);
  });

  it('4. throws when TRIGGER_API_URL missing', () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
    } as never);
    expect(() => resolveTriggerConfig()).toThrow(/TRIGGER_API_URL/);
  });

  it('5. returns valid TriggerConfig when all env vars present', () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
      TRIGGER_DEPLOYMENT: 'self-hosted',
    } as never);
    const cfg = resolveTriggerConfig();
    expect(cfg).toEqual({
      projectRef: 'proj_test',
      secretKey: 'trigger-secret-key-1234567890',
      apiUrl: 'http://trigger-web:3030',
      deployment: 'self-hosted',
    });
  });
});

describe('getTriggerSdk (P1 PR1 — lazy SDK loader)', () => {
  beforeEach(() => {
    // 重置 globalThis cache（每个测试独立）
    const g = globalThis as unknown as { __triggerSdk?: unknown };
    g.__triggerSdk = undefined;
  });

  it('6. throws when RUN_TRIGGER_DEV=0 (no SDK load attempt)', async () => {
    mockedGetEnv.mockReturnValue({ RUN_TRIGGER_DEV: '0' } as never);
    await expect(getTriggerSdk()).rejects.toThrow(/RUN_TRIGGER_DEV=0/);
  });

  it('7. lazy-loads SDK when env fully configured (verifies SDK present)', async () => {
    mockedGetEnv.mockReturnValue({
      RUN_TRIGGER_DEV: '1',
      TRIGGER_PROJECT_REF: 'proj_test',
      TRIGGER_SECRET_KEY: 'trigger-secret-key-1234567890',
      TRIGGER_API_URL: 'http://trigger-web:3030',
      TRIGGER_DEPLOYMENT: 'self-hosted',
    } as never);

    // 不 mock SDK — 真 dynamic import @trigger.dev/sdk 验证 SDK 真实存在
    // 这也证明了 PR1 的 SDK 安装是有效的
    const mod = await getTriggerSdk();
    expect(mod).toBeDefined();
    expect(typeof mod).toBe('object');
  });
});
