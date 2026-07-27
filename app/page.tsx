'use client';

import { useState } from 'react';

export default function Home() {
  const [topic, setTopic] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ jobId: string } | { error: string } | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // trim 防止 whitespace-only topic 通过 disabled 但被 server 拒 (空洞无语意)
    const trimmed = topic.trim();
    if (!trimmed) {
      setResult({ error: 'topic 不能为空或仅空白字符' });
      return;
    }
    setSubmitting(true);
    setResult(null);
    try {
      // 不要在 client 端 hardcode basic auth header:
      //   - dev mode (npm run dev): server route 在 NODE_ENV !== 'production' 时跳过 auth.
      //     user 直接 curl 也行.
      //   - prod mode: nginx 在前面用 basic_auth 拦 (docs/nginx-auto-explainer.conf),
      //     验证后 reverse proxy 到 next.js, client 不需要再发 header.
      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputType: 'text', topic: trimmed }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({ error: data.error ?? `status_${res.status}` });
      } else {
        setResult({ jobId: data.jobId });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setResult({ error: msg });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Auto-Explainer · v0.0.1 alpha</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        内部 alpha。提交一个 topic，等 ~10 分钟拿到 mp4。{' '}
        <a href="/settings">LLM 设置 →</a>
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
        <button type="submit" disabled={submitting || topic.trim().length === 0}>
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