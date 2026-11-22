ALTER TABLE "spec_revisions" ADD COLUMN "approval_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approval_message_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approval_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "criterion_sources" jsonb;