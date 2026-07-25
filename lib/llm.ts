import Anthropic from '@anthropic-ai/sdk';
import { getEnv } from './env';

let client: Anthropic | null = null;

export function getAnthropic() {
  if (client) return client;
  const env = getEnv();
  client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  return client;
}

export interface LlmMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export async function callClaude(opts: {
  system?: string;
  messages: LlmMessage[];
  maxTokens?: number;
  model?: string;
}): Promise<string> {
  const client = getAnthropic();
  // 惰性加载 logger：避免仅为 parseAssistantJson 导入本模块时
  // 触发 logger.ts 顶层的 getEnv() 校验（无 env 的场景如单测会抛错）。
  const { logger } = await import('./logger');
  const params: any = {
    model: opts.model ?? 'claude-sonnet-4-5',
    max_tokens: opts.maxTokens ?? 4096,
    messages: opts.messages,
  };
  if (opts.system) params.system = opts.system;

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await client.messages.create(params);
      const block = res.content[0];
      if (block.type !== 'text') throw new Error('non-text response');
      return block.text;
    } catch (err: unknown) {
      lastErr = err;
      const status =
        err && typeof err === 'object' && 'status' in err ? (err as { status: unknown }).status : undefined;
      if (status && typeof status === 'number' && status >= 400 && status < 500 && status !== 429) break;
      const backoff = Math.min(2 ** attempt * 1000, 16000);
      logger.warn(
        { attempt, backoff, err: err instanceof Error ? err.message : String(err) },
        'claude retry',
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// 从 Claude 文本里抠 JSON（容忍 ```json fence / 前置废话）
export function parseAssistantJson(raw: string): unknown {
  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf('{');
  const firstBracket = trimmed.indexOf('[');
  const starts = [firstBrace, firstBracket].filter((i) => i >= 0);
  if (starts.length > 0) {
    const start = Math.min(...starts);
    return JSON.parse(trimmed.slice(start));
  }
  throw new Error('No JSON found');
}
