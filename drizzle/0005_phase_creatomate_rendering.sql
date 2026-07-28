-- Idempotent: PG 12+ supports `ADD VALUE IF NOT EXISTS`. P1 audit W4 found
-- bare ADD VALUE 重跑抛错 (migration hash tracking + 0006 是同一文件, 双重跑
-- 容易). 现在 drizzle-kit 重 apply 自动 no-op.
ALTER TYPE "public"."phase" ADD VALUE IF NOT EXISTS 'creatomate_rendering' BEFORE 'done';
