ALTER TABLE "conversations" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "team_members" ADD COLUMN "chat_allowed_tool_groups" text[] DEFAULT '{}'::text[] NOT NULL;