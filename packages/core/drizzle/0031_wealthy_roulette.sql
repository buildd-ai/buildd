CREATE TABLE IF NOT EXISTS "task_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"account_id" uuid,
	"kind" text,
	"complexity" text,
	"classified_by" text,
	"predicted_model" text,
	"actual_model" text,
	"downshifted" boolean DEFAULT false NOT NULL,
	"outcome" text NOT NULL,
	"total_cost_usd" text,
	"total_turns" integer,
	"duration_ms" integer,
	"was_retried" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_task_idx" ON "task_outcomes" ("task_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_created_idx" ON "task_outcomes" ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_kind_idx" ON "task_outcomes" ("kind");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
