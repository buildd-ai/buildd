ALTER TABLE "team_members" ADD COLUMN "chat_composer_prefs" jsonb;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "chat_default_tier" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "chat_cap_new_session_tier" boolean DEFAULT false NOT NULL;