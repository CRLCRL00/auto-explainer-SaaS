-- v0.5.5: spec §4.4 Human-in-Loop. jobs.lastError 已存 JSON, 新加 humanInLoopReason
-- varchar 让 dashboard 一眼过滤"撞墙" jobs (4 trigger 之一).
--
-- Idempotent: PG 9.6+ supports `ADD COLUMN IF NOT EXISTS`. P1 audit W4 found bare
-- ADD COLUMN 重跑抛 'column already exists'. 现在 drizzle-kit 重 apply + setup-dev-env.sh
-- 自 apply 都自动 no-op.
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "human_in_loop_reason" varchar(64);
