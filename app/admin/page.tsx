import Link from 'next/link';
import { desc, isNotNull } from 'drizzle-orm';
import { getDb } from '@/lib/db';
import { jobs } from '@/lib/schema';
import { AdminDashboardClient } from './admin-client';

// v0.7.4: Force dynamic rendering. Without this, Next.js prerenders /admin
// at build time → static HTML shows stale job list (e.g. 50 jobs from
// build time, even when DB has 14). We need server-side query on every
// request to show live data.
export const dynamic = 'force-dynamic';

// v0.7.3: spec §4.4 admin dashboard — full web UI with SSE live updates.
// v0.6.1 R6 was the minimal slice (table + filter + 3s polling); v0.7.x
// added retry button + SSE per-job event stream + basic-auth enforcement
// across admin endpoints.
//
// 设计:
//   - server component (默认 Next.js) 查 db, 传纯 data 给 client
//   - client component (admin-client.tsx) 渲染 table + filters + SSE
//   - 状态 sync: 30s polling (fallback) + SSE per-job live push
//   - auth: nginx basic auth prod 已守 + endpoint belt-and-suspenders

interface AdminJobRow {
  id: string;
  status: string;
  phase: string;
  attempts: number;
  inputType: string;
  inputPayload: { topic?: string };
  humanInLoopReason: string | null;
  lastError: { message?: string } | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

async function loadInitialJobs(): Promise<AdminJobRow[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: jobs.id,
      status: jobs.status,
      phase: jobs.phase,
      attempts: jobs.attempts,
      inputType: jobs.inputType,
      inputPayload: jobs.inputPayload,
      humanInLoopReason: jobs.humanInLoopReason,
      lastError: jobs.lastError,
      startedAt: jobs.startedAt,
      finishedAt: jobs.finishedAt,
      createdAt: jobs.createdAt,
    })
    .from(jobs)
    .orderBy(desc(jobs.createdAt))
    .limit(50);
  return rows.map((r) => ({
    ...r,
    inputPayload: { topic: String((r.inputPayload as { topic?: unknown })?.topic ?? '').slice(0, 80) },
  })) as AdminJobRow[];
}

export default async function AdminDashboardPage() {
  const initialJobs = await loadInitialJobs();
  return (
    <main style={{ padding: '20px 40px', fontFamily: 'ui-sans-serif, system-ui', color: '#c9d1d9', background: '#0d1117', minHeight: '100vh' }}>
      <header style={{ borderBottom: '1px solid #30363d', paddingBottom: '16px', marginBottom: '20px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: 700, color: '#58a6ff' }}>Auto-Explainer · Admin Dashboard</h1>
        <p style={{ color: '#8b949e', fontSize: '14px', marginTop: '4px' }}>
          v0.7.3 · spec §4.4 完整 admin · 监控 job 列表 + 撞墙 (human-in-loop) 过滤 + Retry 按钮 + SSE 实时更新
        </p>
        <nav style={{ marginTop: '12px', display: 'flex', gap: '12px' }}>
          <Link href="/" style={{ color: '#58a6ff' }}>← Home</Link>
          <Link href="/settings" style={{ color: '#58a6ff' }}>Settings</Link>
        </nav>
      </header>
      <AdminDashboardClient initialJobs={initialJobs} />
    </main>
  );
}
