CREATE TABLE IF NOT EXISTS "task_recipes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"steps" jsonb NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb,
	"is_public" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_recipes_workspace_idx" ON "task_recipes" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_recipes_category_idx" ON "task_recipes" ("category");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_recipes" ADD CONSTRAINT "task_recipes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_recipes" ADD CONSTRAINT "task_recipes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
