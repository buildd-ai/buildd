CREATE TABLE "prompt_eval_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"benchmark_set" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_source" text NOT NULL,
	"prompt_row_version" integer,
	"prompt_hash" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text,
	"status" text NOT NULL,
	"cases" integer NOT NULL,
	"accuracy" real,
	"baseline_accuracy" real,
	"coverage_at_90" real,
	"accuracy_at_90" real,
	"errors" integer DEFAULT 0 NOT NULL,
	"not_run" integer DEFAULT 0 NOT NULL,
	"cost_usd" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"prompts_ref" text,
	"eval_model" text,
	"prod_model" text,
	"model_mismatch" boolean DEFAULT false NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"loaded_prompts" integer,
	"cost_usd" real,
	"problems" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "prompt_eval_results" ADD CONSTRAINT "prompt_eval_results_run_id_prompt_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."prompt_eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_eval_runs" ADD CONSTRAINT "prompt_eval_runs_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "prompt_eval_results_run_idx" ON "prompt_eval_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "prompt_eval_results_prompt_created_idx" ON "prompt_eval_results" USING btree ("prompt_id","created_at");--> statement-breakpoint
CREATE INDEX "prompt_eval_runs_started_idx" ON "prompt_eval_runs" USING btree ("started_at");