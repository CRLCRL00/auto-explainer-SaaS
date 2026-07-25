import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export function makeTestDb(url: string) {
  const pool = new Pool({ connectionString: url, max: 2 });
  return { pool, db: drizzle(pool) };
}