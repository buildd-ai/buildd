CREATE TABLE IF NOT EXISTS "watched_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"repo" text NOT NULL,
	"vercel_project_id" text,
	"release_pr_filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"in_flight_window_min" integer DEFAULT 60 NOT NULL,
	"prod_grace_min" integer DEFAULT 60 NOT NULL,
	"role_slug" text DEFAULT 'ops' NOT NULL,
	"pushover_app" text DEFAULT 'alerts' NOT NULL,
	"notes" text,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "watcher_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"task_id" uuid,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"fired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_projects_workspace_idx" ON "watched_projects" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watched_projects_enabled_idx" ON "watched_projects" ("enabled");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watched_projects_workspace_repo_idx" ON "watched_projects" ("workspace_id","repo");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "watcher_events_project_kind_key_idx" ON "watcher_events" ("project_id","kind","dedupe_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "watcher_events_project_idx" ON "watcher_events" ("project_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watched_projects" ADD CONSTRAINT "watched_projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watched_projects" ADD CONSTRAINT "watched_projects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "watcher_events" ADD CONSTRAINT "watcher_events_project_id_watched_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "watched_projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
