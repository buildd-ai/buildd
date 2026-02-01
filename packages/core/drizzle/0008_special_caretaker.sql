ALTER TABLE "tasks" DROP CONSTRAINT "tasks_created_by_worker_id_workers_id_fk";
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "git_config" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "config_status" text DEFAULT 'unconfigured' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_config_status_idx" ON "workspaces" ("config_status");