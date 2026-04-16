CREATE TABLE IF NOT EXISTS "user_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"signal" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_feedback_user_entity_idx" ON "user_feedback" ("user_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_entity_idx" ON "user_feedback" ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_feedback_team_idx" ON "user_feedback" ("team_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
