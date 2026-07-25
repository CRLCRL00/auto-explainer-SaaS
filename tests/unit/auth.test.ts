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

  it('rejects wrong user', () => {
    const token = Buffer.from('root:pw').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mw(req)).toBeNull();
  });

  it('accepts password containing colon (first-colon split)', () => {
    // regression: passwords containing ":" must NOT be split
    const mwColonPass = createBasicAuthMiddleware({ user: 'admin', pass: 'a:b' });
    const token = Buffer.from('admin:a:b').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mwColonPass(req)).toBe('admin');
  });

  it('rejects malformed header (no colon in decoded payload)', () => {
    // no colon between user/pass in decoded payload
    const token = Buffer.from('nocolon').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mw(req)).toBeNull();
  });

  it('rejects wrong scheme (Bearer)', () => {
    const token = Buffer.from('admin:pw').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Bearer ${token}` } });
    expect(mw(req)).toBeNull();
  });

  it('does not crash on Unicode credentials (Buffer length compare first)', () => {
    // utf-8 byte length differs from utf-16 string length for non-ASCII
    const user = 'üser';
    const pass = 'paßwörd';
    const mwUnicode = createBasicAuthMiddleware({ user, pass });
    const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `Basic ${token}` } });
    expect(mwUnicode(req)).toBe(user);
  });

  it('treats Basic scheme as case-insensitive', () => {
    const token = Buffer.from('admin:pw').toString('base64');
    const req = new Request('http://x/api', { headers: { authorization: `basic ${token}` } });
    expect(mw(req)).toBe('admin');
  });
});
