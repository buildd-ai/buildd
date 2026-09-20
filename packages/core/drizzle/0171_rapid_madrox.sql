ALTER TABLE "workers" ADD COLUMN "post_supersession_error" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "post_supersession_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "continuation_task_id" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_continuation_task_id_tasks_id_fk" FOREIGN KEY ("continuation_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;