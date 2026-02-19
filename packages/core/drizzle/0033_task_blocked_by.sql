ALTER TABLE "tasks" ADD COLUMN "blocked_by_task_ids" jsonb DEFAULT '[]';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_blocked_by_idx" ON "tasks" USING GIN ("blocked_by_task_ids");
