CREATE INDEX "job_artifacts_job_id_idx" ON "job_artifacts" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_events_job_id_idx" ON "job_events" USING btree ("job_id");