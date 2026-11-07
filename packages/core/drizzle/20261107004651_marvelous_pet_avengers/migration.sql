CREATE TABLE "skill_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"skill_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"action" text NOT NULL,
	"mode" text NOT NULL,
	"reason" text,
	"previous_enabled" boolean,
	"previous_content_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_lifecycle_events_skill_idx" ON "skill_lifecycle_events" ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_lifecycle_events_team_idx" ON "skill_lifecycle_events" ("team_id");--> statement-breakpoint
ALTER TABLE "skill_lifecycle_events" ADD CONSTRAINT "skill_lifecycle_events_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_lifecycle_events" ADD CONSTRAINT "skill_lifecycle_events_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;