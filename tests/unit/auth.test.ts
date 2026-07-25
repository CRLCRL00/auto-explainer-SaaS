import { describe, it, expect } from 'vitest';
import { createBasicAuthMiddleware } from '@/lib/auth';

describe('basicAuth', () => {
  const mw = createBasicAuthMiddleware({ user: 'admin', pass: 'pw' });

  it('rejects when auth header missing', () => {
    const req = new Request('http://x/api');
    expect(mw(req)).toBeNull();
  });

  it('accepts when Basic header matches', () => {
    const token = Buffer.from('admin:pw').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mw(req)).toBe('admin');
  });

  it('rejects wrong password', () => {
    const token = Buffer.from('admin:wrong').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mw(req)).toBeNull();
  });
});
