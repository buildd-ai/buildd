CREATE TABLE "task_estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"estimator_version" text NOT NULL,
	"p50_minutes" real NOT NULL,
	"p80_minutes" real NOT NULL,
	"p50_tokens" integer NOT NULL,
	"p80_tokens" integer NOT NULL,
	"expected_repairs" real DEFAULT 0 NOT NULL,
	"explanation" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "task_estimates" jsonb;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_estimates" ADD CONSTRAINT "task_estimates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_estimates_task_version_idx" ON "task_estimates" USING btree ("task_id","estimator_version");--> statement-breakpoint
CREATE INDEX "task_estimates_workspace_created_idx" ON "task_estimates" USING btree ("workspace_id","created_at");