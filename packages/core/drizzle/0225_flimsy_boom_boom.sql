CREATE TABLE "orchestration_manifest_predictions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"decision_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"candidate_policy_version" text NOT NULL,
	"mode" text NOT NULL,
	"task_created_at" timestamp with time zone NOT NULL,
	"candidates" jsonb NOT NULL,
	"candidate_sources" jsonb NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidate_truncated" boolean DEFAULT false NOT NULL,
	"candidate_omitted" integer DEFAULT 0 NOT NULL,
	"coverage" jsonb NOT NULL,
	"picks" jsonb NOT NULL,
	"selected" jsonb NOT NULL,
	"stop_reason" text NOT NULL,
	"complete" boolean DEFAULT false NOT NULL,
	"unknown_scope" boolean DEFAULT true NOT NULL,
	"all_applied" boolean DEFAULT false NOT NULL,
	"pick_cap" integer NOT NULL,
	"regex_paths" jsonb NOT NULL,
	"neighbour_union_paths" jsonb NOT NULL,
	"latency_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD CONSTRAINT "orchestration_manifest_predictions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD CONSTRAINT "orchestration_manifest_predictions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_manifest_predictions" ADD CONSTRAINT "orchestration_manifest_predictions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "orchestration_manifest_predictions_task_policy_idx" ON "orchestration_manifest_predictions" USING btree ("task_id","candidate_policy_version");--> statement-breakpoint
CREATE INDEX "orchestration_manifest_predictions_workspace_created_idx" ON "orchestration_manifest_predictions" USING btree ("workspace_id","created_at");