CREATE TABLE IF NOT EXISTS "notification_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"task_claimed" boolean DEFAULT true NOT NULL,
	"task_completed" boolean DEFAULT true NOT NULL,
	"task_failed" boolean DEFAULT true NOT NULL,
	"credential_expired" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_team_id_unique" UNIQUE("team_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preferences_team_idx" ON "notification_preferences" ("team_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
