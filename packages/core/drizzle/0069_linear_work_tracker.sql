-- Add work tracker integration column to workspaces
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "work_tracker_config" jsonb;

-- Add external issue tracker link columns to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_issue_id" text;
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "external_issue_url" text;

-- Add external issue tracker link columns to missions
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "external_issue_id" text;
ALTER TABLE "missions" ADD COLUMN IF NOT EXISTS "external_issue_url" text;
