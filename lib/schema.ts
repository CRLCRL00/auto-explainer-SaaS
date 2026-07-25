import { pgTable, uuid, text, timestamp, integer, jsonb, varchar, pgEnum, index } from 'drizzle-orm/pg-core';

// 阶段枚举（spec §3.1）
export const phaseEnum = pgEnum('phase', [
  'pending', 'planning', 'planning_done', 'building', 'html_ready',
  'probing', 'recording', 'recording_done', 'encoding', 'tts_caption',
  'ppt_retro', 'finalize', 'done', 'failed', 'dead',
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
