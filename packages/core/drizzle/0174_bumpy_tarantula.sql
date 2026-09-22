CREATE TABLE "experiment_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"experiment_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"unit_type" text NOT NULL,
	"unit_id" uuid NOT NULL,
	"arm" text NOT NULL,
	"propensity" real NOT NULL,
	"policy_version" integer NOT NULL,
	"default_model" text,
	"assigned_model" text,
	"served" boolean NOT NULL,
	"eligibility" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runner_cli_version" text,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"hypothesis" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"kind" text NOT NULL,
	"treatment_fraction" real DEFAULT 0.5 NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'admins' NOT NULL,
	"decision" text,
	"created_by" uuid,
	"started_at" timestamp with time zone,
	"concluded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_outcomes" ADD COLUMN "exit_cause" text;--> statement-breakpoint
ALTER TABLE "task_outcomes" ADD COLUMN "worker_id" uuid;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_experiment_id_experiments_id_fk" FOREIGN KEY ("experiment_id") REFERENCES "public"."experiments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiment_assignments" ADD CONSTRAINT "experiment_assignments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "experiment_assignments_experiment_task_idx" ON "experiment_assignments" USING btree ("experiment_id","task_id");--> statement-breakpoint
CREATE INDEX "experiment_assignments_experiment_version_arm_idx" ON "experiment_assignments" USING btree ("experiment_id","policy_version","arm");--> statement-breakpoint
CREATE INDEX "experiment_assignments_task_idx" ON "experiment_assignments" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "experiments_team_key_idx" ON "experiments" USING btree ("team_id","key");--> statement-breakpoint
CREATE INDEX "experiments_team_status_kind_idx" ON "experiments" USING btree ("team_id","status","kind");