ALTER TABLE "prompt_eval_results" ADD COLUMN "case_source" text;--> statement-breakpoint
ALTER TABLE "prompt_eval_results" ADD COLUMN "case_origin" text;--> statement-breakpoint
ALTER TABLE "prompt_eval_results" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "prompt_eval_runs" ADD COLUMN "models" jsonb;--> statement-breakpoint
ALTER TABLE "prompt_eval_runs" ADD COLUMN "case_source" text;