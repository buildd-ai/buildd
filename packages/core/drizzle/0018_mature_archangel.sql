ALTER TABLE "workspace_skills" ADD COLUMN "is_role" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "config_storage_key" text;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN "repo_url" text;--> statement-breakpoint
UPDATE "workspace_skills" SET "is_role" = true WHERE "slug" IN ('builder', 'researcher', 'ops', 'finance', 'comms') AND "enabled" = true;