CREATE TABLE "orchestration_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid,
	"task_id" uuid,
	"worker_id" uuid,
	"pr_number" integer,
	"head_sha" text,
	"base_ref" text,
	"base_sha" text,
	"capability" text NOT NULL,
	"decision_id" text NOT NULL,
	"decision_version" text NOT NULL,
	"fingerprint" text NOT NULL,
	"question" text NOT NULL,
	"step" integer DEFAULT 0 NOT NULL,
	"mode" text NOT NULL,
	"min_confidence" real,
	"model" text,
	"candidate_policy_version" text NOT NULL,
	"candidate_digest" text NOT NULL,
	"candidate_count" integer NOT NULL,
	"candidate_truncated" boolean DEFAULT false NOT NULL,
	"rule_verdict" text,
	"suggested" text,
	"confidence" real,
	"effective" text,
	"applied" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"error_kind" text,
	"latency_ms" integer NOT NULL,
	"retrieval_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" real,
	"experiment_arm" text NOT NULL,
	"propensity" real NOT NULL,
	"applying_fraction" real NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orchestration_touch_labels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worker_id" uuid,
	"worker_status" text NOT NULL,
	"touched_paths" jsonb NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"pr_number" integer,
	"head_sha" text,
	"base_ref" text,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "orchestration_decisions" ADD CONSTRAINT "orchestration_decisions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_decisions" ADD CONSTRAINT "orchestration_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_touch_labels" ADD CONSTRAINT "orchestration_touch_labels_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_touch_labels" ADD CONSTRAINT "orchestration_touch_labels_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orchestration_touch_labels" ADD CONSTRAINT "orchestration_touch_labels_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orchestration_decisions_workspace_created_idx" ON "orchestration_decisions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "orchestration_decisions_group_idx" ON "orchestration_decisions" USING btree ("decision_id","fingerprint","experiment_arm");--> statement-breakpoint
CREATE INDEX "orchestration_decisions_task_idx" ON "orchestration_decisions" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orchestration_touch_labels_task_worker_idx" ON "orchestration_touch_labels" USING btree ("task_id","worker_id");--> statement-breakpoint
CREATE INDEX "orchestration_touch_labels_workspace_task_idx" ON "orchestration_touch_labels" USING btree ("workspace_id","task_id");