CREATE TYPE "public"."input_type" AS ENUM('text', 'url', 'doc');--> statement-breakpoint
CREATE TYPE "public"."phase" AS ENUM('pending', 'planning', 'planning_done', 'building', 'html_ready', 'probing', 'recording', 'recording_done', 'encoding', 'tts_caption', 'ppt_retro', 'finalize', 'done', 'failed', 'dead');--> statement-breakpoint
CREATE TABLE "job_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"storage_path" text NOT NULL,
	"size_bytes" integer,
	"sha256" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"phase" varchar(32) NOT NULL,
	"event" varchar(64) NOT NULL,
	"payload" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(64) DEFAULT 'admin' NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"phase" "phase" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_type" "input_type" NOT NULL,
	"input_payload" jsonb NOT NULL,
	"template_id" varchar(64),
	"design_tokens" jsonb,
	"total_cost_cents" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"last_error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "job_artifacts" ADD CONSTRAINT "job_artifacts_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;