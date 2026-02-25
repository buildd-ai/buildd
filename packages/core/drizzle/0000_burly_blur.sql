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
	"level" text DEFAULT 'worker' NOT NULL,
	"name" text NOT NULL,
	"api_key" text NOT NULL,
	"api_key_prefix" text,
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
	"team_id" uuid NOT NULL,
	CONSTRAINT "accounts_api_key_unique" UNIQUE("api_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"workspace_id" uuid,
	"key" text,
	"type" text NOT NULL,
	"title" text,
	"content" text,
	"storage_key" text,
	"share_token" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_code" text NOT NULL,
	"device_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" uuid,
	"api_key" text,
	"client_name" text DEFAULT 'CLI' NOT NULL,
	"level" text DEFAULT 'admin' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code"),
	CONSTRAINT "device_codes_device_token_unique" UNIQUE("device_token")
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
CREATE TABLE IF NOT EXISTS "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worker_id" uuid,
	"task_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb,
	"concepts" jsonb DEFAULT '[]'::jsonb,
	"project" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secret_refs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ref" text NOT NULL,
	"secret_id" uuid NOT NULL,
	"scoped_to_worker_id" text NOT NULL,
	"redeemed" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_refs_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"account_id" uuid,
	"workspace_id" uuid,
	"purpose" text NOT NULL,
	"label" text,
	"encrypted_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"content_hash" text NOT NULL,
	"content" text NOT NULL,
	"source" text,
	"source_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE IF NOT EXISTS "task_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"cron_expression" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"task_template" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_task_id" uuid,
	"total_runs" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"max_concurrent_from_schedule" integer DEFAULT 1 NOT NULL,
	"pause_after_failures" integer DEFAULT 5 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_trigger_value" text,
	"total_checks" integer DEFAULT 0 NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"mode" text DEFAULT 'execution' NOT NULL,
	"runner_preference" text DEFAULT 'any' NOT NULL,
	"required_capabilities" jsonb DEFAULT '[]'::jsonb,
	"claimed_by" uuid,
	"claimed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_by_account_id" uuid,
	"created_by_worker_id" uuid,
	"creation_source" text DEFAULT 'api',
	"parent_task_id" uuid,
	"blocked_by_task_ids" jsonb DEFAULT '[]'::jsonb,
	"category" text,
	"project" text,
	"output_requirement" text DEFAULT 'auto',
	"output_schema" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token" text NOT NULL,
	"invited_by" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_invitations_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "team_members" (
	"team_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_members_team_id_user_id_pk" PRIMARY KEY("team_id","user_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_id" text,
	"github_id" text,
	"email" text NOT NULL,
	"name" text,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "worker_heartbeats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"local_ui_url" text NOT NULL,
	"viewer_token" text,
	"workspace_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_concurrent_workers" integer DEFAULT 3 NOT NULL,
	"active_worker_count" integer DEFAULT 0 NOT NULL,
	"environment" jsonb,
	"last_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"runner" text NOT NULL,
	"branch" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"waiting_for" jsonb,
	"cost_usd" numeric(10, 6) DEFAULT '0' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"turns" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"local_ui_url" text,
	"current_action" text,
	"milestones" jsonb DEFAULT '[]'::jsonb,
	"pr_url" text,
	"pr_number" integer,
	"last_commit_sha" text,
	"commit_count" integer DEFAULT 0,
	"files_changed" integer DEFAULT 0,
	"lines_added" integer DEFAULT 0,
	"lines_removed" integer DEFAULT 0,
	"pending_instructions" text,
	"instruction_history" jsonb DEFAULT '[]'::jsonb,
	"result_meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"repo" text,
	"local_path" text,
	"memory" jsonb DEFAULT '{}'::jsonb,
	"projects" jsonb DEFAULT '[]'::jsonb,
	"github_repo_id" uuid,
	"github_installation_id" uuid,
	"access_mode" text DEFAULT 'open' NOT NULL,
	"git_config" jsonb,
	"config_status" text DEFAULT 'unconfigured' NOT NULL,
	"webhook_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"team_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "accounts_api_key_idx" ON "accounts" ("api_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_github_id_idx" ON "accounts" ("github_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_auth_type_idx" ON "accounts" ("auth_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_seat_id_idx" ON "accounts" ("seat_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "accounts_team_idx" ON "accounts" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_worker_idx" ON "artifacts" ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_share_token_idx" ON "artifacts" ("share_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_workspace_idx" ON "artifacts" ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "artifacts_workspace_key_idx" ON "artifacts" ("workspace_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_codes_user_code_idx" ON "device_codes" ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_codes_device_token_idx" ON "device_codes" ("device_token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_codes_status_idx" ON "device_codes" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_codes_expires_at_idx" ON "device_codes" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_installations_installation_id_idx" ON "github_installations" ("installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_installations_account_login_idx" ON "github_installations" ("account_login");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repos_installation_idx" ON "github_repos" ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "github_repos_repo_id_idx" ON "github_repos" ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "github_repos_full_name_idx" ON "github_repos" ("full_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_workspace_idx" ON "observations" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_type_idx" ON "observations" ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_worker_idx" ON "observations" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_task_idx" ON "observations" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_project_idx" ON "observations" ("project");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secret_refs_ref_idx" ON "secret_refs" ("ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_refs_secret_idx" ON "secret_refs" ("secret_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secret_refs_expires_idx" ON "secret_refs" ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "secrets_team_idx" ON "secrets" ("team_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_account_purpose_idx" ON "secrets" ("account_id","purpose");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "skills_team_slug_idx" ON "skills" ("team_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "skills_team_idx" ON "skills" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sources_workspace_idx" ON "sources" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_schedules_workspace_idx" ON "task_schedules" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_schedules_enabled_next_run_idx" ON "task_schedules" ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_workspace_idx" ON "tasks" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_status_idx" ON "tasks" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_claimed_by_idx" ON "tasks" ("claimed_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_runner_pref_idx" ON "tasks" ("runner_preference");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_mode_idx" ON "tasks" ("mode");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_source_external_idx" ON "tasks" ("source_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_account_idx" ON "tasks" ("created_by_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_task_idx" ON "tasks" ("parent_task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_project_idx" ON "tasks" ("project");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "team_invitations_token_idx" ON "team_invitations" ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_team_idx" ON "team_invitations" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_invitations_email_idx" ON "team_invitations" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_team_idx" ON "team_members" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "team_members_user_idx" ON "team_members" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "teams_slug_idx" ON "teams" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_idx" ON "users" ("google_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_github_id_idx" ON "users" ("github_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_email_idx" ON "users" ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_account_idx" ON "worker_heartbeats" ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "worker_heartbeats_local_ui_url_idx" ON "worker_heartbeats" ("account_id","local_ui_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_heartbeats_heartbeat_idx" ON "worker_heartbeats" ("last_heartbeat_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_task_idx" ON "workers" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_workspace_idx" ON "workers" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_account_idx" ON "workers" ("account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_status_idx" ON "workers" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workers_account_status_idx" ON "workers" ("account_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_skills_workspace_slug_idx" ON "workspace_skills" ("workspace_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_skills_workspace_idx" ON "workspace_skills" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_skills_skill_idx" ON "workspace_skills" ("skill_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_github_repo_idx" ON "workspaces" ("github_repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_github_installation_idx" ON "workspaces" ("github_installation_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_team_idx" ON "workspaces" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_config_status_idx" ON "workspaces" ("config_status");--> statement-breakpoint
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
 ALTER TABLE "accounts" ADD CONSTRAINT "accounts_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "observations" ADD CONSTRAINT "observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secret_refs" ADD CONSTRAINT "secret_refs_secret_id_secrets_id_fk" FOREIGN KEY ("secret_id") REFERENCES "secrets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "skills" ADD CONSTRAINT "skills_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
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
 ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_schedules" ADD CONSTRAINT "task_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
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
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_heartbeats" ADD CONSTRAINT "worker_heartbeats_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE cascade ON UPDATE no action;
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
DO $$ BEGIN
 ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
