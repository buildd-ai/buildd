CREATE TABLE "quality_scout_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"recurrence_key" text NOT NULL,
	"check_id" text NOT NULL,
	"family" text NOT NULL,
	"invariant" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" real,
	"observed" text,
	"evidence_refs" jsonb NOT NULL,
	"reproducibility" text DEFAULT 'unknown' NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"action_state" text DEFAULT 'none' NOT NULL,
	"action_task_id" uuid,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"regression_count" integer DEFAULT 0 NOT NULL,
	"first_seen_run_id" uuid NOT NULL,
	"first_seen_sha" text NOT NULL,
	"last_seen_run_id" uuid NOT NULL,
	"last_seen_sha" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"resolved_run_id" uuid,
	"resolved_sha" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_scout_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"candidate_id" text NOT NULL,
	"family" text NOT NULL,
	"probe_kind" text NOT NULL,
	"title" text NOT NULL,
	"invariant" text NOT NULL,
	"source_signals" jsonb NOT NULL,
	"preconditions" jsonb NOT NULL,
	"executor" text,
	"estimated_cost" text NOT NULL,
	"risk" text NOT NULL,
	"mutates" boolean DEFAULT false NOT NULL,
	"evidence_requirements" jsonb NOT NULL,
	"unsupported_reason" text,
	"selection" jsonb NOT NULL,
	"verdict" text,
	"signature" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quality_scout_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"candidate_ref" text NOT NULL,
	"candidate_sha" text NOT NULL,
	"prior_run_id" uuid,
	"prior_sha" text,
	"budget" jsonb NOT NULL,
	"policy_version" text NOT NULL,
	"candidates_generated" integer,
	"probes_selected" integer,
	"probes_skipped" integer,
	"verdicts" jsonb,
	"cost_usd" numeric(10, 4),
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "quality_scout_findings" ADD CONSTRAINT "quality_scout_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_scout_findings" ADD CONSTRAINT "quality_scout_findings_action_task_id_tasks_id_fk" FOREIGN KEY ("action_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_scout_probes" ADD CONSTRAINT "quality_scout_probes_run_id_quality_scout_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."quality_scout_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_scout_probes" ADD CONSTRAINT "quality_scout_probes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD CONSTRAINT "quality_scout_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quality_scout_runs" ADD CONSTRAINT "quality_scout_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "quality_scout_findings_workspace_signature_idx" ON "quality_scout_findings" USING btree ("workspace_id","signature");--> statement-breakpoint
CREATE INDEX "quality_scout_findings_workspace_check_idx" ON "quality_scout_findings" USING btree ("workspace_id","check_id","state");--> statement-breakpoint
CREATE INDEX "quality_scout_findings_workspace_state_idx" ON "quality_scout_findings" USING btree ("workspace_id","state","last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "quality_scout_probes_run_candidate_idx" ON "quality_scout_probes" USING btree ("run_id","candidate_id");--> statement-breakpoint
CREATE INDEX "quality_scout_probes_workspace_signature_idx" ON "quality_scout_probes" USING btree ("workspace_id","signature");--> statement-breakpoint
CREATE INDEX "quality_scout_runs_workspace_created_idx" ON "quality_scout_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "quality_scout_runs_workspace_ref_idx" ON "quality_scout_runs" USING btree ("workspace_id","candidate_ref","created_at");