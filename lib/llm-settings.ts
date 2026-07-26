// Per-task paste override for LLM provider + model + baseURL + apiKey.
// v0.0.1 alpha: plaintext JSON at storage/.llm-settings.json (user-authorized).
// Atomic write: write to .tmp then rename.
// Schema: { provider?, model?, baseURL?, apiKey? } | null.
// 这个模块故意保持纯净：测试可在无 env stub 的情况下导入；logger 延迟到写入路径再 import。

import { promises as fs } from 'node:fs';
import path from 'node:path';

export type LlmProvider = 'anthropic' | 'openai-compatible';

export const DEFAULT_PROVIDER: LlmProvider = 'anthropic';

export interface LlmSettings {
  provider?: LlmProvider;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export interface RedactedLlmSettings {
  provider: LlmProvider;
  model: string | null;
  baseURL: string | null;
  configured: boolean;
}

export const DEFAULT_SETTINGS_PATH = path.resolve(process.cwd(), 'storage', '.llm-settings.json');

function isProvider(v: unknown): v is LlmProvider {
  return v === 'anthropic' || v === 'openai-compatible';
}

export async function readLlmSettings(filePath: string = DEFAULT_SETTINGS_PATH): Promise<LlmSettings | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    // 缺文件 / 无权限 → 当作未配置
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 损坏的 JSON：当作未配置（错误不抛，alpha 期间宽松处理）
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const out: LlmSettings = {};
  if (isProvider(obj.provider)) out.provider = obj.provider;
  if (typeof obj.model === 'string' && obj.model.length > 0) out.model = obj.model;
  if (typeof obj.baseURL === 'string' && obj.baseURL.length > 0) out.baseURL = obj.baseURL;
  if (typeof obj.apiKey === 'string' && obj.apiKey.length > 0) out.apiKey = obj.apiKey;
  return out;
}

export async function writeLlmSettings(
  settings: LlmSettings,
  filePath: string = DEFAULT_SETTINGS_PATH,
): Promise<void> {
  // 仅保留 string/enum 字段，避免 undefined 落盘
  const payload: Record<string, string> = {};
  if (isProvider(settings.provider)) payload.provider = settings.provider;
  if (typeof settings.model === 'string' && settings.model.length > 0) payload.model = settings.model;
  if (typeof settings.baseURL === 'string' && settings.baseURL.length > 0) payload.baseURL = settings.baseURL;
  if (typeof settings.apiKey === 'string' && settings.apiKey.length > 0) payload.apiKey = settings.apiKey;

  // 原子写入：先写 .tmp，再 rename。fs.rename 在同文件系统下是原子的。
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
  await fs.rename(tmpPath, filePath);
}

export async function clearLlmSettings(filePath: string = DEFAULT_SETTINGS_PATH): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
}

// 永远不要把 apiKey 值透出 API。返回 provider + model + baseURL + configured 标记。
export function redactSettings(settings: LlmSettings | null): RedactedLlmSettings {
  if (!settings) {
    return { provider: DEFAULT_PROVIDER, model: null, baseURL: null, configured: false };
  }
  return {
    provider: isProvider(settings.provider) ? settings.provider : DEFAULT_PROVIDER,
    model: typeof settings.model === 'string' && settings.model.length > 0 ? settings.model : null,
    baseURL: typeof settings.baseURL === 'string' && settings.baseURL.length > 0 ? settings.baseURL : null,
    configured: typeof settings.apiKey === 'string' && settings.apiKey.length > 0,
  };
}