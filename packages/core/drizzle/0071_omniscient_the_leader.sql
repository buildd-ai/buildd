CREATE TYPE "public"."connector_transport" AS ENUM('http', 'stdio');--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "transport" "connector_transport" DEFAULT 'http' NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "command" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "args" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "env_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "connector_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;