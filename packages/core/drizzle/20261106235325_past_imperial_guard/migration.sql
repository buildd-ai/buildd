CREATE TABLE "skill_usage" (
	"skill_id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"first_claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_usage_team_idx" ON "skill_usage" ("team_id");--> statement-breakpoint
ALTER TABLE "skill_usage" ADD CONSTRAINT "skill_usage_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage" ADD CONSTRAINT "skill_usage_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;