ALTER TABLE "mission_notes" ADD COLUMN "subject_task_id" uuid;--> statement-breakpoint
ALTER TABLE "mission_notes" ADD COLUMN "options" jsonb;