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
ALTER TABLE "decision_records" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "attempt_count" integer;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "escalated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "failure_class" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "subject_type" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "subject_id" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "experiment_id" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "experiment_arm" text;--> statement-breakpoint
ALTER TABLE "decision_records" ADD COLUMN "propensity" real;--> statement-breakpoint
ALTER TABLE "decision_challenger_runs" ADD CONSTRAINT "decision_challenger_runs_decision_record_id_decision_records_id_fk" FOREIGN KEY ("decision_record_id") REFERENCES "public"."decision_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_challenger_runs" ADD CONSTRAINT "decision_challenger_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_decision_record_id_decision_records_id_fk" FOREIGN KEY ("decision_record_id") REFERENCES "public"."decision_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_outcomes" ADD CONSTRAINT "decision_outcomes_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "decision_challenger_runs_decision_key_idx" ON "decision_challenger_runs" USING btree ("decision_record_id","challenger_key");--> statement-breakpoint
CREATE INDEX "decision_challenger_runs_team_capability_idx" ON "decision_challenger_runs" USING btree ("team_id","capability","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "decision_outcomes_decision_source_idx" ON "decision_outcomes" USING btree ("decision_record_id","source");--> statement-breakpoint
CREATE INDEX "decision_outcomes_team_capability_idx" ON "decision_outcomes" USING btree ("team_id","capability");--> statement-breakpoint
CREATE INDEX "decision_records_subject_idx" ON "decision_records" USING btree ("team_id","capability","subject_type","subject_id");