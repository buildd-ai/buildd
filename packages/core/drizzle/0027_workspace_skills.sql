-- Add content column to skills table (nullable for backward compat with hash-only records)
ALTER TABLE "skills" ADD COLUMN "content" text;

-- Create workspace_skills table
CREATE TABLE IF NOT EXISTS "workspace_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"skill_id" uuid,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"source" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"origin" text DEFAULT 'manual' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workspace_skills" ADD CONSTRAINT "workspace_skills_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "skills"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_skills_workspace_slug_idx" ON "workspace_skills" ("workspace_id","slug");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_skills_workspace_idx" ON "workspace_skills" ("workspace_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_skills_skill_idx" ON "workspace_skills" ("skill_id");
