ALTER TABLE "objectives" ADD COLUMN IF NOT EXISTS "default_role_slug" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "role_slug" text;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "model" text DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "allowed_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "can_delegate_to" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "background" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "max_turns" integer;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "color" text DEFAULT '#8A8478' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "mcp_servers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_skills" ADD COLUMN IF NOT EXISTS "required_env_vars" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- Data migration: assign distinct colors to existing skills
UPDATE "workspace_skills" SET "color" = sub.new_color
FROM (
  SELECT id AS sid, CASE (ROW_NUMBER() OVER (ORDER BY created_at) - 1) % 8
    WHEN 0 THEN '#C45A3B'
    WHEN 1 THEN '#5B7BB3'
    WHEN 2 THEN '#6B8E5E'
    WHEN 3 THEN '#D97706'
    WHEN 4 THEN '#9B59B6'
    WHEN 5 THEN '#2C8C99'
    WHEN 6 THEN '#C4783B'
    ELSE '#8A8478'
  END AS new_color
  FROM "workspace_skills"
) sub
WHERE "workspace_skills".id = sub.sid;