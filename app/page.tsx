'use client';

import { useState } from 'react';

export default function Home() {
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ jobId: string } | { error: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setResult(null);
    try {
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Basic ${Buffer.from(`${process.env.NEXT_PUBLIC_BASIC_AUTH_USER ?? 'admin'}:${process.env.NEXT_PUBLIC_BASIC_AUTH_PASS ?? 'changeme'}`).toString('base64')}`,
        },
        body: JSON.stringify({ inputType: 'text', topic }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResult({ error: data.error ?? 'unknown' });
      } else {
        setResult({ jobId: data.jobId });
      }
    } catch (err: any) {
      setResult({ error: err.message });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Auto-Explainer · v0.0.1 alpha</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        内部 alpha。提交一个 topic，等 ~10 分钟拿到 mp4。
      </p>
      <form onSubmit={onSubmit}>
        <label htmlFor="topic">Topic 主题（中英都行，≤500 字）</label>
        <textarea
          id="topic"
          rows={3}
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="例如：RAG 的工作原理"
          maxLength={500}
          required
        />
        <button type="submit" disabled={submitting || topic.length === 0}>
          {submitting ? '提交中…' : '开始生成'}
        </button>
      </form>
      {result && 'jobId' in result && (
        <div className="result">
          ✅ 已提交。jobId = <code>{result.jobId}</code>
          <br />
          <a href={`/jobs/${result.jobId}`}>查看进度 →</a>
        </div>
      )}
      {result && 'error' in result && (
        <div className="result" style={{ color: '#f85149' }}>❌ {result.error}</div>
      )}
    </main>
  );
}