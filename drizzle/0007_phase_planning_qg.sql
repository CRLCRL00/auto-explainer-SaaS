-- v0.6.1 audit gap: phase enum 漏 'planning_qg' + 'script_ready'.
--
-- 背景:
--   Drizzle lib/schema.ts:phaseEnum 自 commit b7d3ea2 (v0.5 QG-plan 落地) 起
--   声明 'planning_qg' 与 'script_ready' 两值. 实际 DB enum 是 0000_bored_dazzler.sql
--   创建, 列表 — 漏这两个. commit 6baa9fa (QG-plan integration) 在 phaseQgPlan
--   末 set jobs.phase = 'planning_qg' 立即暴露这个缺口 — 真跑 pipeline
--   会撞 'invalid input syntax for type phase: planning_qg'. dev walk-through
--   绕过因为没真调 phaseQgPlan / phaseScript.
--
-- 修法 (PG 12+ IF NOT EXISTS):
--   注意: ALTER TYPE ADD VALUE 不允许 BEFORE/AFTER 引用不存在的 label —
--   'script_ready' 在 DB 不存在, 所以这条 plain ADD VALUE 不带位置. 值会被
--   append 到 enum 末尾 (display order 在 PG 是 enum sortorder, 不影响列值查询).
ALTER TYPE "public"."phase" ADD VALUE IF NOT EXISTS 'planning_qg';--> statement-breakpoint
ALTER TYPE "public"."phase" ADD VALUE IF NOT EXISTS 'script_ready';