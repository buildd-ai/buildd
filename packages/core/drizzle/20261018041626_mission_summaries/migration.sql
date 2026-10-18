CREATE TABLE "mission_summaries" (
	"mission_id" uuid PRIMARY KEY,
	"workspace_id" uuid,
	"version" integer NOT NULL,
	"summary" jsonb NOT NULL,
	"last_activity_at" timestamp with time zone,
	"computed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mission_summaries_workspace_idx" ON "mission_summaries" ("workspace_id");--> statement-breakpoint
CREATE INDEX "mission_summaries_computed_at_idx" ON "mission_summaries" ("computed_at");--> statement-breakpoint
ALTER TABLE "mission_summaries" ADD CONSTRAINT "mission_summaries_mission_id_missions_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "mission_summaries" ADD CONSTRAINT "mission_summaries_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;