CREATE TABLE IF NOT EXISTS "observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"worker_id" uuid,
	"task_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb,
	"concepts" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_workspace_idx" ON "observations" ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_type_idx" ON "observations" ("type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_worker_idx" ON "observations" ("worker_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "observations_task_idx" ON "observations" ("task_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "observations" ADD CONSTRAINT "observations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
