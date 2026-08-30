CREATE TABLE "memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"project" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"files" text[] DEFAULT '{}' NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memories_team_idx" ON "memories" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "memories_team_updated_idx" ON "memories" USING btree ("team_id","updated_at");--> statement-breakpoint
CREATE INDEX "memories_team_project_idx" ON "memories" USING btree ("team_id","project");--> statement-breakpoint
-- Expand/contract: the column is NOT dropped here. Production code in the previous
-- release still selects teams.memory_api_key, and db:migrate runs before next build,
-- so dropping it now makes the outgoing deployment query a column that no longer
-- exists for the whole build window. Values are cleared instead (they are plaintext
-- credentials and nothing reads them after this release); the column itself is
-- dropped in a follow-up migration once this code is live in production.
UPDATE "teams" SET "memory_api_key" = NULL;