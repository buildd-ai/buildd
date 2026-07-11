ALTER TABLE "missions" ADD COLUMN "external_issue_id" text;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "external_issue_url" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_issue_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "external_issue_url" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "work_tracker_config" jsonb;