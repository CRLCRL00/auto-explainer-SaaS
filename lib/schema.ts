import { pgTable, uuid, text, timestamp, integer, jsonb, varchar, pgEnum, index } from 'drizzle-orm/pg-core';

// 阶段枚举（spec §3.1）
// v0.0.1 新增 'script_ready'：位于 'planning_qg' 之后 / 'building' 之前，
// 给 ScriptWriter 用（Task 15）。
// P0 全量: 新增 'creatomate_rendering'（encode hard cut 后取代 'encoding'）。
// 'encoding' 仍保留一个 minor 版本防数据反查冲突, 后续迁移完成可 drop.
export const phaseEnum = pgEnum('phase', [
  'pending', 'planning', 'planning_done', 'planning_qg', 'script_ready', 'building', 'html_ready',
  'probing', 'recording', 'recording_done', 'encoding', 'creatomate_rendering',
  'tts_caption', 'ppt_retro', 'finalize', 'done', 'failed', 'dead',
]);

export const inputTypeEnum = pgEnum('input_type', ['text', 'url', 'doc']);

// v0.0.1 只用 text，其他 enum 值预留

export const jobs = pgTable('jobs', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: varchar('user_id', { length: 64 }).notNull().default('admin'), // v0.0.1 hardcoded
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  phase: phaseEnum('phase').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  inputType: inputTypeEnum('input_type').notNull(),
  inputPayload: jsonb('input_payload').notNull(),  // { topic: string } for v0.0.1
  templateId: varchar('template_id', { length: 64 }),
  designTokens: jsonb('design_tokens'),
  totalCostCents: integer('total_cost_cents').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  lastError: jsonb('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const jobEvents = pgTable('job_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  phase: varchar('phase', { length: 32 }).notNull(),
  event: varchar('event', { length: 64 }).notNull(),
  payload: jsonb('payload'),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('job_events_job_id_idx').on(table.jobId),
]);

export const jobArtifacts = pgTable('job_artifacts', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 32 }).notNull(),  // html / mp4 / mp3 / srt / pptx / retrospective
  storagePath: text('storage_path').notNull(),
  sizeBytes: integer('size_bytes'),
  sha256: varchar('sha256', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('job_artifacts_job_id_idx').on(table.jobId),
]);

// P1 PR2: Trigger.dev run-id 审计表 — 写到本地避免每次切到 Trigger.dev dashboard 看状态。
// 字段集:
//   jobId   → 关联 jobs (cascade delete)
//   runId   → Trigger.dev 返回的 run id (用于后续 runs.retrieve 状态拉取)
//   status  → 'pending' | 'running' | 'completed' | 'failed' (由 worker 端 SDK 状态 polling 更新)
//   startedAt / finishedAt → SDK 端 webhooks/PR3 worker 端 polling 同步写
// 注意: PR2 仅声明表 + 写 migration 文件; PR3 worker 端负责 populate.
export const triggerRuns = pgTable('trigger_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  runId: varchar('run_id', { length: 128 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('trigger_runs_job_id_idx').on(table.jobId),
]);
