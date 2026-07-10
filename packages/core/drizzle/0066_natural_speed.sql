CREATE TYPE "public"."connector_auth_mode" AS ENUM('none', 'header', 'oauth');--> statement-breakpoint
CREATE TABLE "connector_workspaces" (
	"connector_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "connector_workspaces_connector_id_workspace_id_pk" PRIMARY KEY("connector_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"auth_mode" "connector_auth_mode" DEFAULT 'none' NOT NULL,
	"header_name" text,
	"discovered_metadata" jsonb,
	"client_id" text,
	"encrypted_client_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connector_workspaces" ADD CONSTRAINT "connector_workspaces_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_workspaces" ADD CONSTRAINT "connector_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connector_workspaces_workspace_idx" ON "connector_workspaces" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "connectors_team_idx" ON "connectors" USING btree ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_team_name_idx" ON "connectors" USING btree ("team_id","name");