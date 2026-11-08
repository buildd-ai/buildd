CREATE TABLE "model_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"team_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"task_id" uuid,
	"chain_id" uuid,
	"parent_worker_id" uuid,
	"resolved_model" text,
	"endpoint_kind" text DEFAULT 'unknown' NOT NULL,
	"model_version" text,
	"quantization" text,
	"context_window" integer,
	"backend" text,
	"harness_version" text,
	"runtime" jsonb,
	"task_class" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_ms" integer,
	"generation_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"tokens_per_second" real,
	"turns" integer,
	"retries" integer DEFAULT 0 NOT NULL,
	"tool_failures" integer,
	"terminal_outcome" text DEFAULT 'unknown' NOT NULL,
	"exit_cause" text,
	"failure_origin" text DEFAULT 'unknown' NOT NULL,
	"peak_vram_mb" integer,
	"vram_samples" integer,
	"cost_usd" numeric(10,6),
	"cost_basis" text,
	"unavailable" jsonb DEFAULT '{}' NOT NULL,
	"review_verdict" text,
	"ci_state" text,
	"spec_verdict" text,
	"pr_outcome" text,
	"reworked" boolean DEFAULT false NOT NULL,
	"evidence_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "model_observations_worker_attempt_idx" ON "model_observations" ("worker_id","attempt");--> statement-breakpoint
CREATE INDEX "model_observations_team_model_idx" ON "model_observations" ("team_id","resolved_model");--> statement-breakpoint
CREATE INDEX "model_observations_workspace_created_idx" ON "model_observations" ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "model_observations_chain_idx" ON "model_observations" ("chain_id");--> statement-breakpoint
CREATE INDEX "model_observations_task_idx" ON "model_observations" ("task_id");--> statement-breakpoint
ALTER TABLE "model_observations" ADD CONSTRAINT "model_observations_team_id_teams_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_observations" ADD CONSTRAINT "model_observations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "model_observations" ADD CONSTRAINT "model_observations_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;