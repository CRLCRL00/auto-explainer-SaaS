import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(10),
  // P2 OpenRouter fallback for minimax — leave OPENROUTER_API_KEY empty to disable fallback.
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  OPENROUTER_BASE_URL: z.string().url().optional(),
  OPENROUTER_FALLBACK_MODEL: z.string().min(1).optional(),

  // P0 全量: Creatomate SaaS 是默认 render path. P0 POC 的 RUN_CREATOMATE_POC
  // flag 已废弃 — P0 全量 commit C2 删除 RUN_CREATOMATE_POC env schema 字段.
  // P0 全量上线期间硬切, AGENTS 视觉验收已通过 (deployment-side 验证).
  CREATOMATE_API_KEY: z.string().min(10),
  CREATOMATE_BASE_URL: z.string().url().optional(),
  CREATOMATE_TEMPLATE_ID: z.string().min(1).default('creatomate-builtin-30s-5beats'),
  CREATOMATE_POLL_MS: z.coerce.number().int().positive().default(3000),
  CREATOMATE_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  // TTS 仍 optional —— 视频可不出配音. Azure Speech 真 key 部署侧 env 注入.
  AZURE_SPEECH_KEY: z.string().min(10).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),

  // P1 PR1: Trigger.dev v4 self-hosted (introduced, NOT wired).
  // RUN_TRIGGER_DEV=0 default: behaviour identical to pre-PR1 (BullMQ still active).
  // Only exercised in PR3+ cut-over; PR1 just adds env schema + lib/trigger.ts.
  TRIGGER_PROJECT_REF: z.string().min(1).optional(),
  TRIGGER_SECRET_KEY: z.string().min(10).optional(),
  TRIGGER_API_URL: z.string().url().optional(),
  TRIGGER_DEPLOYMENT: z.enum(['self-hosted', 'cloud']).default('self-hosted'),
  // P1 PR3: changed default '0' → '1'. After deploy, workers will use Trigger.dev
  // by default; set RUN_TRIGGER_DEV=0 to opt out (BullMQ primary path).
  RUN_TRIGGER_DEV: z.enum(['0', '1']).default('1'),

  // v0.5.5: Human-in-Loop webhook URL (spec §4.4). 配了即撞墙时 POST 给 owner.
  HUMAN_IN_LOOP_WEBHOOK_URL: z.string().url().optional(),

  BASIC_AUTH_USER: z.string().min(1),
  BASIC_AUTH_PASS: z.string().min(1),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

let cached: z.infer<typeof envSchema> | null = null;

export function getEnv() {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = JSON.stringify(parsed.error.flatten().fieldErrors);
    console.error('[env] Invalid env:', detail);
    throw new Error(`Invalid environment: ${detail}`);
  }
  cached = parsed.data;
  return cached;
}