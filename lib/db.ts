import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from './env';
import * as schema from './schema';
import { logger } from './logger';

let pool: Pool | null = null;

export function getPool() {
  if (pool) return pool;
  const env = getEnv();
  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 10,
  });
  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;