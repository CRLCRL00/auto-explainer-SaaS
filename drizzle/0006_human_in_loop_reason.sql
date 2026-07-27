-- v0.5.5: spec §4.4 Human-in-Loop. jobs.lastError 已存 JSON, 新加 humanInLoopReason
-- varchar 让 dashboard 一眼过滤"撞墙" jobs (4 trigger 之一).
ALTER TABLE "jobs" ADD COLUMN "human_in_loop_reason" varchar(64);
