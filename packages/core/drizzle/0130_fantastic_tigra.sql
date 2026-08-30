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
ALTER TABLE "teams" DROP COLUMN "memory_api_key";