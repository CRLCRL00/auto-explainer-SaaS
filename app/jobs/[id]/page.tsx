'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface Job {
  id: string;
  status: string;
  phase: string;
  attempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  lastError: any;
}

export default function JobStatusPage() {
  const params = useParams<{ id: string }>();
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      try {
        const res = await fetch(`/api/jobs/${params.id}`, {
          headers: {
            authorization: `Basic ${Buffer.from(`${process.env.NEXT_PUBLIC_BASIC_AUTH_USER ?? 'admin'}:${process.env.NEXT_PUBLIC_BASIC_AUTH_PASS ?? 'changeme'}`).toString('base64')}`,
          },
        });
        if (cancelled) return;
        if (res.status === 404) { setError('Job not found'); return; }
        const data = await res.json();
        setJob(data);
        if (data.status !== 'done' && data.status !== 'failed' && data.status !== 'dead') {
          timer = setTimeout(poll, 5000);
        }
      } catch (e: unknown) {
        if (e instanceof Error) setError(e.message);
      }
    }

    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [params.id]);

  if (error) return <main><h1>❌ {error}</h1></main>;
  if (!job) return <main><h1>loading…</h1></main>;

  return (
    <main>
      <h1>Job {job.id.slice(0, 8)}…</h1>
      <p><b>Status:</b> {job.status}</p>
      <p><b>Phase:</b> {job.phase}</p>
      <p><b>Attempts:</b> {job.attempts}</p>
      {job.lastError && (
        <div className="result" style={{ color: '#f85149' }}>
          <b>Last error:</b> <pre>{JSON.stringify(job.lastError, null, 2)}</pre>
        </div>
      )}
      {job.status === 'done' && (
        <div className="result">
          ✅ 完成。<a href={`/api/jobs/${job.id}/download/mp4`}>下载 mp4</a>
        </div>
      )}
    </main>
  );
}
