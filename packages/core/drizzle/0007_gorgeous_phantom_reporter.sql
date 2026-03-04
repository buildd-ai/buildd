ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "discord_config" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "slack_config" jsonb;