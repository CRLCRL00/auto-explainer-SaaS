import { z } from 'zod';

export const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  ANTHROPIC_API_KEY: z.string().min(10),
  // P2 OpenRouter fallback for minimax — leave OPENROUTER_API_KEY empty to disable fallback.
  OPENROUTER_API_KEY: z.string().min(10).optional(),
  OPENROUTER_BASE_URL: z.string().url().optional(),
  OPENROUTER_FALLBACK_MODEL: z.string().min(1).optional(),

  // P0 POC: Creatomate SaaS + Azure TTS
  CREATOMATE_API_KEY: z.string().min(10).optional(),
  CREATOMATE_BASE_URL: z.string().url().optional(),
  CREATOMATE_TEMPLATE_ID: z.string().min(1).optional(),
  AZURE_SPEECH_KEY: z.string().min(10).optional(),
  AZURE_SPEECH_REGION: z.string().min(1).optional(),
  RUN_CREATOMATE_POC: z.enum(['0', '1']).default('0'),
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