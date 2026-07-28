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
  // production-grade tuning (audit preventive PR4):
  //   - max:           max 同时间 connections in pool. dev 10, prod 可通过
  //                    DB_POOL_MAX 调高 (e.g., 30).
  //   - connectionTimeoutMillis: 5s — 等连接可用最长. 防 SDK 卡死 (e.g., DB
  //                    重启、network 抖).
  //   - idleTimeoutMillis: 30s — idle connection 释放, 让 DB 腾出 slot.
  //   - statement_timeout: 30s — server-side 单 query 超时 kill. 防慢 query
  //                    占住 connection 致 pool 耗尽.
  //   - query_timeout:  30s — client-side timeout (与 statement_timeout 互补).
  //   - ssl: production 是否 require / verify-full — dev 留 false (pg default).
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: Number(process.env.DB_POOL_MAX ?? 10),
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    query_timeout: 30_000,
  });
  pool.on('error', (err) => logger.error({ err }, 'pg pool error'));
  g.__pgPool = pool;
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export type Db = ReturnType<typeof getDb>;