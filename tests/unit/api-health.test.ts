import { describe, it, expect } from 'vitest';

// 测 /api/health GET 返回 200 + body shape 对. 不 import Next.js runtime
// (免依赖), 直接 inline call handler.
describe('GET /api/health (liveness probe)', () => {
  it('returns 200 + ok status', async () => {
    const { GET } = await import('@/app/api/health/route');
    const res = GET();
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.status).toBe('ok');
    expect(typeof data.uptimeSeconds).toBe('number');
  });
});
