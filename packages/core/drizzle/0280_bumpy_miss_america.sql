ALTER TABLE "workspaces" ADD COLUMN "new_starts_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "new_starts_paused_by" text;