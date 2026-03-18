DROP TABLE "secret_refs";--> statement-breakpoint
ALTER TABLE "workspace_skills" ALTER COLUMN "mcp_servers" SET DEFAULT '{}'::jsonb;