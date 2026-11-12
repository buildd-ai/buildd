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
CREATE TABLE "skill_spec_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"skill_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"confirmed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_usage" (
	"skill_id" uuid PRIMARY KEY,
	"team_id" uuid NOT NULL,
	"claim_count" integer DEFAULT 0 NOT NULL,
	"first_claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "skill_lifecycle_events_skill_idx" ON "skill_lifecycle_events" ("skill_id","created_at");--> statement-breakpoint
CREATE INDEX "skill_lifecycle_events_team_idx" ON "skill_lifecycle_events" ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_spec_links_pair_unique" ON "skill_spec_links" ("skill_id","spec_id");--> statement-breakpoint
CREATE INDEX "skill_spec_links_spec_idx" ON "skill_spec_links" ("spec_id");--> statement-breakpoint
CREATE INDEX "skill_usage_team_idx" ON "skill_usage" ("team_id");--> statement-breakpoint
ALTER TABLE "skill_lifecycle_events" ADD CONSTRAINT "skill_lifecycle_events_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_lifecycle_events" ADD CONSTRAINT "skill_lifecycle_events_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage" ADD CONSTRAINT "skill_usage_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_usage" ADD CONSTRAINT "skill_usage_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;