CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "skills" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_workspace_idx" ON "skills" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_workspace_slug_idx" ON "skills" ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_enabled_idx" ON "skills" ("enabled");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
