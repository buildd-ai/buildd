CREATE TABLE IF NOT EXISTS "worker_error_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"pattern" text NOT NULL,
	"excerpt" text NOT NULL,
	"source" text,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_error_traces_worker_ts_idx" ON "worker_error_traces" ("worker_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_error_traces_task_ts_idx" ON "worker_error_traces" ("task_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "worker_error_traces_pattern_idx" ON "worker_error_traces" ("pattern");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_error_traces" ADD CONSTRAINT "worker_error_traces_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "worker_error_traces" ADD CONSTRAINT "worker_error_traces_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
