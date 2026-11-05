ALTER TABLE "specs" ADD COLUMN "kind" text DEFAULT 'contract' NOT NULL;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "created_by_task_id" uuid;