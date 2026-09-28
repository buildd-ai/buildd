CREATE TABLE "memory_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"workspace_id" uuid,
	"task_id" uuid,
	"memory_id" text,
	"decision" text NOT NULL,
	"version" text NOT NULL,
	"mode" text NOT NULL,
	"verdict" text,
	"confidence" real,
	"probability" real,
	"rule" text,
	"applied" boolean DEFAULT false NOT NULL,
	"error" text,
	"caller" text,
	"latency_ms" integer,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_decisions_team_decision_idx" ON "memory_decisions" USING btree ("team_id","decision","created_at");--> statement-breakpoint
CREATE INDEX "memory_decisions_task_idx" ON "memory_decisions" USING btree ("task_id");