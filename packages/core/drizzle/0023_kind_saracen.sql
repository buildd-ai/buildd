-- Drop the old skills table (created via db:push with different columns)
-- and recreate with the correct schema (owner_id instead of workspace_id)
DROP TABLE IF EXISTS "skills";--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content_hash" text NOT NULL,
	"source" text,
	"source_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_owner_slug_idx" ON "skills" ("owner_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_owner_idx" ON "skills" ("owner_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
