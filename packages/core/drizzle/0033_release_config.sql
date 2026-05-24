ALTER TABLE "workspaces" ADD COLUMN "release_config" jsonb;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "release" text DEFAULT 'inherit';
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "release_result" jsonb;
