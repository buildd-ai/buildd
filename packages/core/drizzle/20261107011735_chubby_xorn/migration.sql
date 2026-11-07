CREATE TABLE "skill_spec_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"skill_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"confirmed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "skill_spec_links_pair_unique" ON "skill_spec_links" ("skill_id","spec_id");--> statement-breakpoint
CREATE INDEX "skill_spec_links_spec_idx" ON "skill_spec_links" ("spec_id");--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_skill_id_workspace_skills_id_fkey" FOREIGN KEY ("skill_id") REFERENCES "workspace_skills"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "skill_spec_links" ADD CONSTRAINT "skill_spec_links_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;