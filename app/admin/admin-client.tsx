'use client';

import { useEffect, useState } from 'react';

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

interface Props {
  initialJobs: AdminJobRow[];
}

// v0.7: client component for /admin — uses Server-Sent Events instead of polling.
// Subscribe to /api/admin/jobs/[id]/events for each row (one EventSource per row)
// → live push when retry / phase change.

export function AdminDashboardClient({ initialJobs }: Props) {
  const [jobs, setJobs] = useState<AdminJobRow[]>(initialJobs);
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [onlyHumanInLoop, setOnlyHumanInLoop] = useState(false);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  // Initial fetch + filter change fetch (REST, not SSE)
  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const params = new URLSearchParams();
        if (filterStatus !== 'all') params.set('status', filterStatus);
        if (onlyHumanInLoop) params.set('humanInLoop', '1');
        const res = await fetch(`/api/admin/jobs?${params.toString()}`);
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.error('admin jobs poll failed', res.status);
          return;
        }
        const data = await res.json() as { jobs: AdminJobRow[] };
        if (!cancelled) {
          const normalized = data.jobs.map((j) => ({
            ...j,
            createdAt: j.createdAt ? new Date(j.createdAt as unknown as string) : new Date(0),
            startedAt: j.startedAt ? new Date(j.startedAt as unknown as string) : null,
            finishedAt: j.finishedAt ? new Date(j.finishedAt as unknown as string) : null,
            lastError: j.lastError ?? null,
          }));
          setJobs(normalized);
          setLastRefresh(new Date());
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('admin jobs poll error', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    setLoading(true);
    poll();
    const id = setInterval(poll, 30_000); // 30s polling as fallback
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [filterStatus, onlyHumanInLoop]);

  // SSE per-job subscription for live updates
  useEffect(() => {
    const sources: EventSource[] = [];
    for (const j of jobs) {
      const es = new EventSource(`/api/admin/jobs/${j.id}/events`);
      es.addEventListener('state', (ev) => {
        try {
          const data = JSON.parse((ev as MessageEvent).data) as {
            id: string;
            status: string;
            phase: string;
            attempts: number;
            humanInLoopReason: string | null;
            lastError: { message?: string } | null;
            finishedAt: string | null;
            startedAt: string | null;
            updatedAt: string;
          };
          setJobs((prev) =>
            prev.map((p) =>
              p.id === data.id
                ? {
                    ...p,
                    status: data.status,
                    phase: data.phase,
                    attempts: data.attempts,
                    humanInLoopReason: data.humanInLoopReason,
                    lastError: data.lastError,
                    finishedAt: data.finishedAt ? new Date(data.finishedAt) : null,
                    startedAt: data.startedAt ? new Date(data.startedAt) : null,
                  }
                : p,
            ),
          );
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error('SSE state parse error', e);
        }
      });
      es.onerror = () => {
        // EventSource auto-reconnects on close; we just log
        // eslint-disable-next-line no-console
        console.warn('SSE connection error for job', j.id);
      };
      sources.push(es);
    }
    return () => {
      for (const es of sources) es.close();
    };
    // Intentional: re-subscribe only when the *set of job IDs* changes, not on
    // every status/phase update. The SSE stream itself pushes state updates,
    // so re-subscribing on every state tick would cause an infinite re-mount
    // loop. The .join(',') expression is stable enough as a deps array sentinel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs.map((j) => j.id).join(',')]);

  // Stats
  const stats = {
    total: jobs.length,
    running: jobs.filter((j) => j.status === 'running').length,
    done: jobs.filter((j) => j.status === 'done').length,
    failed: jobs.filter((j) => j.status === 'failed').length,
    wallHit: jobs.filter((j) => j.humanInLoopReason !== null).length,
    // Subset: wall-hit jobs that are also in failed state (the most common
    // wall-hit outcome — QG-flagged + status flipped to failed). Surfaced as
    // a sub-text on the Wall-hit card so users don't double-count failed +
    // wall-hit (they're often the same jobs).
    wallHitAndFailed: jobs.filter((j) => j.humanInLoopReason !== null && j.status === 'failed').length,
  };

  return (
    <div>
      {/* Stats panel */}
      <section style={{ display: 'flex', gap: '12px', marginBottom: '20px', flexWrap: 'wrap' }}>
        <StatCard label="Total" value={stats.total} />
        <StatCard label="Running" value={stats.running} accent="#58a6ff" />
        <StatCard label="Done" value={stats.done} accent="#3fb950" />
        <StatCard label="Failed" value={stats.failed} accent="#f85149" />
        <StatCard
          label="Wall-hit (need attention)"
          value={stats.wallHit}
          accent="#d29922"
          sub={stats.wallHitAndFailed > 0 ? `${stats.wallHitAndFailed} also failed — see Retry column` : undefined}
        />
      </section>

      {/* Filters */}
      <section style={{ marginBottom: '16px', display: 'flex', gap: '12px', alignItems: 'center' }}>
        <label>
          Status:&nbsp;
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ background: '#161b22', color: '#c9d1d9', border: '1px solid #30363d', padding: '4px 8px', borderRadius: '4px' }}
          >
            <option value="all">all</option>
            <option value="pending">pending</option>
            <option value="running">running</option>
            <option value="done">done</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={onlyHumanInLoop}
            onChange={(e) => setOnlyHumanInLoop(e.target.checked)}
            data-testid="filter-wallhit"
          />
          &nbsp;Only wall-hit jobs
        </label>
        <span style={{ marginLeft: 'auto', color: '#8b949e', fontSize: '13px' }}>
          {loading ? '刷新中...' : `last refresh: ${lastRefresh.toLocaleTimeString()}`}
        </span>
      </section>

      {/* Jobs table */}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
        <thead>
          <tr style={{ borderBottom: '2px solid #30363d', textAlign: 'left', color: '#8b949e' }}>
            <th style={{ padding: '8px' }}>Job ID</th>
            <th style={{ padding: '8px' }}>Topic</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Phase</th>
            <th style={{ padding: '8px' }}>Attempts</th>
            <th style={{ padding: '8px' }}>Wall reason</th>
            <th style={{ padding: '8px' }}>Last error</th>
            <th style={{ padding: '8px' }}>Started</th>
            <th style={{ padding: '8px' }}>Created</th>
            <th style={{ padding: '8px' }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => (
            <tr key={j.id} style={{ borderBottom: '1px solid #21262d' }}>
              <td style={{ padding: '8px', fontFamily: 'ui-monospace, monospace', fontSize: '12px' }}>{j.id.slice(0, 8)}…</td>
              <td style={{ padding: '8px' }}>{j.inputPayload.topic || '—'}</td>
              <td style={{ padding: '8px' }}>
                <StatusBadge status={j.status} />
              </td>
              <td style={{ padding: '8px', color: '#8b949e' }}>{j.phase}</td>
              <td style={{ padding: '8px' }}>{j.attempts}</td>
              <td style={{ padding: '8px', color: j.humanInLoopReason ? '#d29922' : '#8b949e', fontFamily: 'ui-monospace', fontSize: '12px' }}>
                {j.humanInLoopReason ?? '—'}
              </td>
              <td style={{ padding: '8px', color: '#f85149', fontSize: '12px', maxWidth: '280px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {j.lastError?.message ?? '—'}
              </td>
              <td style={{ padding: '8px', color: '#8b949e', fontSize: '12px' }}>
                {j.startedAt ? j.startedAt.toLocaleString() : '—'}
              </td>
              <td style={{ padding: '8px', color: '#8b949e', fontSize: '12px' }}>
                {j.createdAt.toLocaleString()}
              </td>
              <td style={{ padding: '8px' }}>
                <RetryButton jobId={j.id} status={j.status} wallHit={j.humanInLoopReason !== null} />
              </td>
            </tr>
          ))}
          {jobs.length === 0 ? (
            <tr>
              <td colSpan={10} style={{ padding: '20px', textAlign: 'center', color: '#8b949e' }}>
                没有 jobs (当前 filter).
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function StatCard({ label, value, accent, sub }: { label: string; value: number; accent?: string; sub?: string }) {
  return (
    <div
      style={{
        background: '#161b22',
        padding: '12px 16px',
        borderRadius: '6px',
        border: '1px solid #30363d',
        minWidth: '120px',
      }}
    >
      <div style={{ color: '#8b949e', fontSize: '12px', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: accent ?? '#c9d1d9', fontSize: '24px', fontWeight: 700, marginTop: '4px' }}>{value}</div>
      {sub && <div style={{ color: '#8b949e', fontSize: '11px', marginTop: '4px' }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colorMap: Record<string, string> = {
    pending: '#8b949e',
    running: '#58a6ff',
    done: '#3fb950',
    failed: '#f85149',
    dead: '#6e7681',
  };
  return (
    <span
      style={{
        background: colorMap[status] ?? '#8b949e',
        color: '#0d1117',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 600,
      }}
    >
      {status}
    </span>
  );
}

function RetryButton({ jobId, status, wallHit }: { jobId: string; status: string; wallHit: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const retryable = status === 'failed' || status === 'dead' || wallHit;

  async function onRetry() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch(`/api/admin/jobs/${jobId}/retry`, { method: 'POST' });
      const data = await res.json() as { retried: boolean; runId?: string; error?: string; detail?: string };
      if (data.retried) {
        setResult(`✓ retried (runId=${data.runId?.slice(0, 8)}…)`);
      } else {
        setResult(`✗ ${data.error ?? 'unknown'}: ${data.detail ?? ''}`);
      }
    } catch (e) {
      setResult(`✗ ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  if (!retryable) return <span style={{ color: '#8b949e' }}>—</span>;

  return (
    <span>
      <button
        type="button"
        onClick={onRetry}
        disabled={busy}
        data-testid={`retry-${jobId.slice(0, 8)}`}
        style={{
          background: '#3fb950',
          color: '#0d1117',
          border: 'none',
          padding: '4px 10px',
          borderRadius: '4px',
          cursor: busy ? 'wait' : 'pointer',
          fontSize: '12px',
          fontWeight: 600,
          opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? '…' : 'Retry'}
      </button>
      {result && (
        <span style={{ marginLeft: '6px', fontSize: '11px', color: result.startsWith('✓') ? '#3fb950' : '#f85149' }}>
          {result}
        </span>
      )}
    </span>
  );
}
