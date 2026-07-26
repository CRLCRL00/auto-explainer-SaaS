'use client';

import { useEffect, useState } from 'react';

// LLM Settings page — per-task paste override for provider + model + baseURL + apiKey.
// v0.0.1 alpha: settings stored locally at storage/.llm-settings.json, never committed.
// Auth: Basic via btoa() (matches Task 9 client-bundle fix).
//
// Provider dispatch:
//   - 'anthropic' (default): uses @anthropic-ai/sdk, apiKey falls back to env.ANTHROPIC_API_KEY
//   - 'openai-compatible': uses openai SDK with optional baseURL
//                          (DeepSeek / DashScope / OpenRouter / Ollama / vLLM ... 都兼容)
// Claude 快捷按钮：点一下把 model 输入框填成 Sonnet/Opus/Haiku，不动 provider。

type Provider = 'anthropic' | 'openai-compatible';

interface CurrentSettings {
  provider: Provider;
  model: string | null;
  baseURL: string | null;
  configured: boolean;
}

type Result =
  | { status: 'ok'; message: string }
  | { status: 'err'; message: string };

const PROVIDER_OPTIONS: { value: Provider; label: string }[] = [
  { value: 'anthropic', label: 'Anthropic (Claude 系列)' },
  { value: 'openai-compatible', label: 'OpenAI-compatible (DeepSeek / 通义 / Ollama ...)' },
];

const CLAUDE_PRESETS: { value: string; label: string }[] = [
  { value: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (推荐)' },
  { value: 'claude-opus-4-5', label: 'Claude Opus 4.5 (最强)' },
  { value: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku (最快/最便宜)' },
];

const DEFAULT_PROVIDER: Provider = 'anthropic';
const DEFAULT_MODEL = 'claude-sonnet-4-5';

function authHeader(): string {
  return `Basic ${btoa(`${process.env.NEXT_PUBLIC_BASIC_AUTH_USER ?? 'admin'}:${process.env.NEXT_PUBLIC_BASIC_AUTH_PASS ?? 'changeme'}`)}`;
}

export default function SettingsPage() {
  const [provider, setProvider] = useState<Provider>(DEFAULT_PROVIDER);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [baseURL, setBaseURL] = useState('');
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
          setProvider(data.provider);
          if (data.model) setModel(data.model);
          if (data.baseURL) setBaseURL(data.baseURL);
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

  function pickClaudePreset(value: string) {
    setProvider('anthropic'); // 切到 Anthropic 因为这些是 Claude 模型
    setModel(value);
  }

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      const payload: Record<string, string> = {
        provider,
        model,
        apiKey,
      };
      // baseURL 只在 openai-compatible 时有意义；留空不发送避免污染 anthropic 配置
      if (provider === 'openai-compatible' && baseURL.trim().length > 0) {
        payload.baseURL = baseURL.trim();
      }

      const res = await fetch('/api/llm-settings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authHeader(),
        },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const msg = typeof data?.error === 'string' ? data.error : `save_failed_${res.status}`;
        setResult({ status: 'err', message: msg });
      } else {
        setResult({ status: 'ok', message: '已保存。' });
        setApiKey('');
        // 更新本地视图，不重新拉取
        setCurrent({
          provider,
          model,
          baseURL: provider === 'openai-compatible' ? baseURL.trim() || null : null,
          configured: true,
        });
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
        setCurrent({ provider: DEFAULT_PROVIDER, model: null, baseURL: null, configured: false });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'unknown';
      setResult({ status: 'err', message: msg });
    } finally {
      setBusy(false);
    }
  }

  const showBaseURL = provider === 'openai-compatible';

  return (
    <main>
      <h1>Auto-Explainer · v0.0.1 alpha</h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        LLM Settings（每次任务粘贴覆盖）— key 仅本地保存，绝不入 git。
      </p>

      <div className="result" style={{ marginBottom: 20 }}>
        <div>
          <b>当前 provider：</b>{' '}
          {loaded ? (current?.provider ?? DEFAULT_PROVIDER) : '加载中…'}
        </div>
        <div>
          <b>当前模型：</b>{' '}
          {loaded ? (current?.model ?? '未设置') : '加载中…'}
        </div>
        <div>
          <b>Base URL：</b>{' '}
          {loaded
            ? current?.baseURL
              ? current.baseURL
              : <span style={{ color: 'var(--muted)' }}>（默认）</span>
            : '加载中…'}
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
        <label htmlFor="provider">Provider 提供方</label>
        <select
          id="provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          disabled={busy}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <label htmlFor="model">
          Model 模型（任意字符串；留空保存时保留旧 model；不修改 model 只改 key 也可以）
        </label>
        <input
          id="model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={current?.model ?? DEFAULT_MODEL}
          autoComplete="off"
          disabled={busy}
        />

        {/* Claude 快捷：点一下填到 model 框 + 切回 anthropic provider */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
          <span style={{ color: 'var(--muted)', fontSize: '0.85em', alignSelf: 'center' }}>
            Claude 快捷：
          </span>
          {CLAUDE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => pickClaudePreset(p.value)}
              disabled={busy}
              style={{
                background: '#21262d',
                color: 'var(--fg)',
                fontSize: '0.85em',
                padding: '4px 10px',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>

        {showBaseURL && (
          <>
            <label htmlFor="baseURL">
              Base URL（OpenAI-compatible endpoint，留空走官方 API）
            </label>
            <input
              id="baseURL"
              type="text"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.deepseek.com/v1"
              autoComplete="off"
              disabled={busy}
            />
          </>
        )}

        <label htmlFor="apiKey">
          API Key（{showBaseURL ? <code>sk-...</code> : <code>sk-ant-...</code>}；留空保存时保留旧 key；只改 model 也可以）
        </label>
        <input
          id="apiKey"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={current?.configured ? '（已配置；留空保留旧 key）' : showBaseURL ? 'sk-...' : 'sk-ant-...'}
          autoComplete="off"
          disabled={busy}
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button
            type="submit"
            disabled={busy || (apiKey.length === 0 && model.trim().length === 0)}
          >
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