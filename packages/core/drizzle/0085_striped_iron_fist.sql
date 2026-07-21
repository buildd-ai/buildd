CREATE TABLE "model_tier_registry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"tier" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"default_effort" text,
	"default_max_turns" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "model_tier_registry" ADD CONSTRAINT "model_tier_registry_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_tier_registry" ADD CONSTRAINT "model_tier_registry_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_tier_registry_unique" ON "model_tier_registry" USING btree ("team_id","workspace_id","tier") NULLS NOT DISTINCT;--> statement-breakpoint
CREATE INDEX "model_tier_registry_team_idx" ON "model_tier_registry" USING btree ("team_id");