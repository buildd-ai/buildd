CREATE TABLE IF NOT EXISTS "account_workspaces" (
	"account_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"can_claim" boolean DEFAULT true NOT NULL,
	"can_create" boolean DEFAULT false NOT NULL,
	CONSTRAINT "account_workspaces_account_id_workspace_id_pk" PRIMARY KEY("account_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"api_key" text NOT NULL,
	"github_id" text,
	"auth_type" text DEFAULT 'api' NOT NULL,
	"anthropic_api_key" text,
	"max_cost_per_day" numeric(10, 2),
	"total_cost" numeric(10, 2) DEFAULT '0' NOT NULL,
	"oauth_token" text,
	"seat_id" text,
	"max_concurrent_sessions" integer,
	"active_sessions" integer DEFAULT 0 NOT NULL,
	"max_concurrent_workers" integer DEFAULT 3 NOT NULL,
	"total_tasks" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"content" text,
	"storage_key" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid,
	"worker_id" uuid,
	"content" text NOT NULL,
	"selection" jsonb,
	"resolved" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" bigint NOT NULL,
	"account_type" text NOT NULL,
	"account_login" text NOT NULL,
	"account_id" bigint NOT NULL,
	"account_avatar_url" text,
	"access_token" text,
	"token_expires_at" timestamp with time zone,
	"permissions" jsonb DEFAULT '{}'::jsonb,
	"repository_selection" text,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "github_installations_installation_id_unique" UNIQUE("installation_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"installation_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"name" text NOT NULL,
	"owner" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"default_branch" text DEFAULT 'main',
	"html_url" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text,
	"tool_name" text,
	"tool_input" jsonb,
	"tool_output" text,
	"cost_usd" numeric(10, 6),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid,
	"external_id" text,
	"external_url" text,
	"title" text NOT NULL,
	"description" text,
	"context" jsonb DEFAULT '{}'::jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"runner_preference" text DEFAULT 'any' NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid,
	"workspace_id" uuid NOT NULL,
	"account_id" uuid,
	"name" text NOT NULL,
	"branch" text NOT NULL,
	"worktree_path" text,
	"status" text DEFAULT 'idle' NOT NULL,
	"waiting_for" jsonb,
	"progress" integer DEFAULT 0 NOT NULL,
	"sdk_session_id" text,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"local_ui_url" text,
	"current_action" text,
	"milestones" jsonb DEFAULT '[]'::jsonb,
	"pr_url" text,
	"pr_number" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"repo" text,
	"local_path" text,
	"memory" jsonb DEFAULT '{}'::jsonb,
	"github_repo_id" uuid,
	"github_installation_id" uuid,
	"access_mode" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_api_key_idx" ON "accounts" ("api_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_github_id_idx" ON "accounts" ("github_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_auth_type_idx" ON "accounts" ("auth_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_seat_id_idx" ON "accounts" ("seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_worker_idx" ON "artifacts" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attachments_message_idx" ON "attachments" ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "comments_artifact_idx" ON "comments" ("artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_installation_id_idx" ON "github_installations" ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_account_login_idx" ON "github_installations" ("account_login");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repos_installation_idx" ON "github_repos" ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_repos_repo_id_idx" ON "github_repos" ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repos_full_name_idx" ON "github_repos" ("full_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_worker_idx" ON "messages" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_workspace_idx" ON "sources" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_idx" ON "tasks" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_claimed_by_idx" ON "tasks" ("claimed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_runner_pref_idx" ON "tasks" ("runner_preference");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_source_external_idx" ON "tasks" ("source_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_task_idx" ON "workers" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_workspace_idx" ON "workers" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_account_idx" ON "workers" ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_status_idx" ON "workers" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_github_repo_idx" ON "workspaces" ("github_repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_github_installation_idx" ON "workspaces" ("github_installation_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_workspaces" ADD CONSTRAINT "account_workspaces_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_workspaces" ADD CONSTRAINT "account_workspaces_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comments" ADD CONSTRAINT "comments_artifact_id_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "comments" ADD CONSTRAINT "comments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_repos" ADD CONSTRAINT "github_repos_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_claimed_by_accounts_id_fk" FOREIGN KEY ("claimed_by") REFERENCES "accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workers" ADD CONSTRAINT "workers_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workers" ADD CONSTRAINT "workers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workers" ADD CONSTRAINT "workers_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
