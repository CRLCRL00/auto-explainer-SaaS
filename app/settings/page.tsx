'use client';

import { useEffect, useState } from 'react';

// LLM Settings page — per-task paste override for model + apiKey.
// v0.0.1 alpha: key stored locally at storage/.llm-settings.json, never committed.
// Auth: Basic via btoa() (matches Task 9 client-bundle fix).

interface CurrentSettings {
  model: string | null;
  configured: boolean;
}

type Result =
  | { status: 'ok'; message: string }
  | { status: 'err'; message: string };

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (推荐)' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (最强)' },
  { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (最快/最便宜)' },
];

const DEFAULT_MODEL = 'claude-sonnet-4-5';

function authHeader(): string {
  return `Basic ${btoa(`${process.env.NEXT_PUBLIC_BASIC_AUTH_USER ?? 'admin'}:${process.env.NEXT_PUBLIC_BASIC_AUTH_PASS ?? 'changeme'}`)}`;
}

export default function SettingsPage() {
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [current, setCurrent] = useState<CurrentSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  // GET initial state once on mount. Cache-friendly: no refetch after save/clear.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/llm-settings', {
          headers: { authorization: authHeader() },
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as CurrentSettings;
          setCurrent(data);
          if (data.model) setModel(data.model);
        }
      } catch {
        // 非阻塞：GET 失败仍让用户编辑表单
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/llm-settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader(),
        },
        body: JSON.stringify({ model, apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : `save_failed_${res.status}`;
        setResult({ status: 'err', message: msg });
      } else {
        setResult({ status: 'ok', message: '已保存。' });
        setApiKey('');
        // 更新本地视图，不重新拉取
        setCurrent({ model, configured: true });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setResult({ status: 'err', message: msg });
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (!confirm('确定要清空 LLM 设置吗？已保存的 key 会被删除。')) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch('/api/llm-settings', {
        method: 'DELETE',
        headers: { authorization: authHeader() },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = typeof data?.error === 'string' ? data.error : `clear_failed_${res.status}`;
        setResult({ status: 'err', message: msg });
      } else {
        setResult({ status: 'ok', message: '已清空。' });
        setApiKey('');
        setCurrent({ model: null, configured: false });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setResult({ status: 'err', message: msg });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Auto-Explainer · v0.0.1 alpha</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        LLM Settings（每次任务粘贴覆盖）— key 仅本地保存，绝不入 git。
      </p>

      <div className="result" style={{ marginBottom: 20 }}>
        <div>
          <b>当前模型：</b>{' '}
          {loaded ? (current?.model ?? '未设置') : '加载中…'}
        </div>
        <div>
          <b>Key 状态：</b>{' '}
          {loaded
            ? current?.configured
              ? '✓ 已配置'
              : '✗ 未配置'
            : '加载中…'}
        </div>
      </div>

      <form onSubmit={onSave}>
        <label htmlFor="model">Model 模型</label>
        <select
          id="model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={busy}
        >
          {MODEL_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <label htmlFor="apiKey">
          API Key（<code>sk-ant-...</code>，粘贴后保存即覆盖）
        </label>
        <input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={current?.configured ? '（已配置，留空保存可保留旧 key）' : 'sk-ant-...'}
          autoComplete="off"
          disabled={busy}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button type="submit" disabled={busy || apiKey.length === 0}>
            {busy ? '保存中…' : '保存'}
          </button>
          <button
            type="button"
            onClick={onClear}
            disabled={busy || !current?.configured}
            style={{ background: '#21262d', color: 'var(--fg)' }}
          >
            清空
          </button>
        </div>
      </form>

      {result && result.status === 'ok' && (
        <div className="result" style={{ color: 'var(--accent)' }}>
          ✅ {result.message}
        </div>
      )}
      {result && result.status === 'err' && (
        <div className="result" style={{ color: '#f85149' }}>
          ❌ {result.message}
        </div>
      )}

      <p style={{ marginTop: 24 }}>
        <a href="/">← 返回提交页</a>
      </p>
    </main>
  );
}