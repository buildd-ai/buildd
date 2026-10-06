CREATE TABLE "post_session_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"signature" text NOT NULL,
	"recurrence_key" text,
	"class" text NOT NULL,
	"severity" text NOT NULL,
	"confidence" numeric(4, 3),
	"title" text NOT NULL,
	"summary" text,
	"proposed_action" text NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"affected_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"action_state" text DEFAULT 'observed' NOT NULL,
	"action_task_id" uuid,
	"action_artifact_id" uuid,
	"action_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_session_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"workspace_id" uuid NOT NULL,
	"mission_id" uuid,
	"policy_version" text NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'collecting' NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"facts" jsonb,
	"facts_schema_version" integer,
	"transcript_availability" text,
	"trace_availability" text,
	"trace_source" text,
	"trace_missing" jsonb,
	"triage" jsonb,
	"hard_triggered" boolean,
	"hard_trigger_reasons" jsonb,
	"final_decision" text,
	"error_stage" text,
	"last_error" text,
	"failed_at" timestamp with time zone,
	"collected_at" timestamp with time zone,
	"triaged_at" timestamp with time zone,
	"analysed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "post_session_findings" ADD CONSTRAINT "post_session_findings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_findings" ADD CONSTRAINT "post_session_findings_action_task_id_tasks_id_fk" FOREIGN KEY ("action_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_findings" ADD CONSTRAINT "post_session_findings_action_artifact_id_artifacts_id_fk" FOREIGN KEY ("action_artifact_id") REFERENCES "public"."artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_runs" ADD CONSTRAINT "post_session_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_runs" ADD CONSTRAINT "post_session_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_runs" ADD CONSTRAINT "post_session_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_session_runs" ADD CONSTRAINT "post_session_runs_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_session_findings_ws_signature_policy_idx" ON "post_session_findings" USING btree ("workspace_id","signature","policy_version");--> statement-breakpoint
CREATE INDEX "post_session_findings_ws_recurrence_idx" ON "post_session_findings" USING btree ("workspace_id","recurrence_key");--> statement-breakpoint
CREATE INDEX "post_session_findings_action_state_idx" ON "post_session_findings" USING btree ("action_state");--> statement-breakpoint
CREATE UNIQUE INDEX "post_session_runs_worker_policy_idx" ON "post_session_runs" USING btree ("worker_id","policy_version");--> statement-breakpoint
CREATE INDEX "post_session_runs_workspace_created_idx" ON "post_session_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "post_session_runs_state_updated_idx" ON "post_session_runs" USING btree ("state","updated_at");--> statement-breakpoint
CREATE INDEX "post_session_runs_task_idx" ON "post_session_runs" USING btree ("task_id");