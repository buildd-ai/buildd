ALTER TABLE "task_schedules" ADD COLUMN "last_deferral_reason" text;--> statement-breakpoint
ALTER TABLE "task_schedules" ADD COLUMN "last_deferred_at" timestamp with time zone;