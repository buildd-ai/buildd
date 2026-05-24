ALTER TABLE "tasks" ADD COLUMN "schedule_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tasks" ADD CONSTRAINT "tasks_schedule_id_task_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "task_schedules"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_schedule_idx" ON "tasks" ("schedule_id");