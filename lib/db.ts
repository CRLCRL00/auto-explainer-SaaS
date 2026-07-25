import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from './env';
import * as schema from './schema';
import { logger } from './logger';

// HMR-safe singleton: stash pool on globalThis so Next.js dev mode's
// module re-evaluation doesn't leak duplicate Pool instances.
const g = globalThis as unknown as { __pgPool?: Pool };

export function getPool() {
  if (g.__pgPool) return g.__pgPool;
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
  });
  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  g.__pgPool = pool;
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;