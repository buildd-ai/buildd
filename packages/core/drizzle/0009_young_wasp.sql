ALTER TABLE "tasks" ADD COLUMN "mode" text DEFAULT 'execution' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_mode_idx" ON "tasks" ("mode");