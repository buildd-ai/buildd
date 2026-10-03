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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_records" ADD CONSTRAINT "decision_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decision_records_workspace_created_idx" ON "decision_records" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "decision_records_capability_created_idx" ON "decision_records" USING btree ("capability","created_at");--> statement-breakpoint
CREATE INDEX "decision_records_task_idx" ON "decision_records" USING btree ("task_id");