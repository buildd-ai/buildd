ALTER TABLE "tasks" ADD COLUMN "created_by_account_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "created_by_worker_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "creation_source" text DEFAULT 'api';--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parent_task_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_account_idx" ON "tasks" ("created_by_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_parent_task_idx" ON "tasks" ("parent_task_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_account_id_accounts_id_fk" FOREIGN KEY ("created_by_account_id") REFERENCES "accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_worker_id_workers_id_fk" FOREIGN KEY ("created_by_worker_id") REFERENCES "workers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
