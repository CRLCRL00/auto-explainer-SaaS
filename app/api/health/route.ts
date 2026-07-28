import { NextResponse } from 'next/server';

// 强制 dynamic — health check 不能被 Next.js static cache (错的话 deploy.sh
// 一直拿到 200 假阳性, 实际 app crash 也看不出来).
export const dynamic = 'force-dynamic';

const startedAt = Date.now();

/**
 * GET /api/health — liveness probe for `scripts/deploy.sh:65` + 外部监控.
 *
 * 设计选择:
 *   - Liveness 而非 readiness: 只检查 "Next.js 进程能不能 serve 请求".
 *     DB / Trigger.dev 单独有 readiness probe (k8s style); 这次只 unlock deploy
 *     script 的死亡死锁.
 *   - 不需 auth: deploy.sh 是本机 loopback curl, 不带 credentials. production
 *     hardening 仍走 nginx basic auth on /api/jobs, /api/jobs/[id], 等业务路由;
 *     /api/health 故意是 public liveness endpoint.
 *   - 不依赖 lib/db / lib/env: cold-start 时 DB env 还没 parse 也能 200.
 *     业务路由 POST 401/500 在 deploy.sh 的第 65 行之前已经能 curl 验通了.
 *
 * Body shape (for future /api/ready PR):
 *   { status: 'ok', version, uptimeSeconds }
 */
export function GET() {
  return NextResponse.json({
    status: 'ok',
    version: process.env.npm_package_version ?? 'unknown',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
}
