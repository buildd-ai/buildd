ALTER TABLE "task_subject_claims" ALTER COLUMN "canonical_task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "task_subject_claims" ADD COLUMN "reservation_token" uuid;--> statement-breakpoint
ALTER TABLE "task_subject_claims" ADD COLUMN "reservation_expires_at" timestamp with time zone;