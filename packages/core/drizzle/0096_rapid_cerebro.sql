ALTER TABLE "mission_notes" ADD COLUMN "superseded_by_pr_number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ci_retry_pr_number" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "ci_retry_head_sha" text;--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_ci_retry_event_unique" ON "tasks" USING btree ("workspace_id","ci_retry_pr_number","ci_retry_head_sha") WHERE "tasks"."creation_source" = 'webhook' AND "tasks"."ci_retry_pr_number" IS NOT NULL AND "tasks"."ci_retry_head_sha" IS NOT NULL;