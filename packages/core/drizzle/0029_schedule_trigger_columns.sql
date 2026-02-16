-- Add trigger-related columns to task_schedules for conditional schedule execution
ALTER TABLE "task_schedules" ADD COLUMN "last_checked_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "last_trigger_value" text;
--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "total_checks" integer DEFAULT 0 NOT NULL;
