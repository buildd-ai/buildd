CREATE TABLE "decision_challenger_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_record_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"challenger_key" text NOT NULL,
	"status" text NOT NULL,
	"skip_reason" text,
	"provider" text,
	"model" text,
	"model_version" text,
	"outcome" text,
	"decision" text,
	"confidence" real,
	"applied_answer" text,
	"agrees" boolean,
	"failure_kind" text,
	"latency_ms" integer,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"decision_record_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"capability" text NOT NULL,
	"source" text NOT NULL,
	"label" text NOT NULL,
	"value" real,
	"metadata" jsonb,
	"observed_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decision_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"mission_id" uuid,
	"task_id" uuid,
	"capability" text NOT NULL,
	"fingerprint" text NOT NULL,
	"prompt_version" text,
	"model" text,
	"min_confidence" real,
	"rule_answer" text,
	"verdict" text,
	"confidence" real,
	"applied_answer" text,
	"applied" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"latency_ms" integer,
	"input_tokens" integer,
	"cost_usd" real,
	"human_override" jsonb,
	"overridden_at" timestamp with time zone,
	"overridden_by" uuid,
	"policy_version" text,
	"provider" text,
	"attempt_count" integer,
	"escalated" boolean DEFAULT false NOT NULL,
	"failure_class" text,
	"subject_type" text,
	"subject_id" text,
	"experiment_id" text,
	"experiment_arm" text,
	"propensity" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_challenger_runs" ADD CONSTRAINT "decision_challenger_runs_decision_record_id_decision_records_id_fk" FOREIGN KEY ("decision_record_id") REFERENCES "public"."decision_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_challenger_runs" ADD CONSTRAINT "decision_challenger_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_decision_record_id_decision_records_id_fk" FOREIGN KEY ("decision_record_id") REFERENCES "public"."decision_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_challenger_runs_decision_key_idx" ON "decision_challenger_runs" USING btree ("decision_record_id","challenger_key");--> statement-breakpoint
CREATE INDEX "decision_challenger_runs_team_capability_idx" ON "decision_challenger_runs" USING btree ("team_id","capability","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_outcomes_decision_source_idx" ON "decision_outcomes" USING btree ("decision_record_id","source");--> statement-breakpoint
CREATE INDEX "decision_outcomes_team_capability_idx" ON "decision_outcomes" USING btree ("team_id","capability");--> statement-breakpoint
CREATE INDEX "decision_records_workspace_created_idx" ON "decision_records" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_records_capability_created_idx" ON "decision_records" USING btree ("capability","created_at");--> statement-breakpoint
CREATE INDEX "decision_records_task_idx" ON "decision_records" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "decision_records_subject_idx" ON "decision_records" USING btree ("team_id","capability","subject_type","subject_id");