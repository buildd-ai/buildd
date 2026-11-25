CREATE TABLE "spec_intent_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"spec_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"content_hash" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_ids" jsonb NOT NULL,
	"checker_account_id" text NOT NULL,
	"checker_task_id" text,
	"questions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec_owner_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"spec_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"text" text NOT NULL,
	"recommended" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"answer" jsonb
);
--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approval_conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approval_message_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approval_message_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "criterion_sources" jsonb;--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_intent_checks_spec_revision_idx" ON "spec_intent_checks" ("spec_id","revision");--> statement-breakpoint
CREATE INDEX "spec_owner_questions_workspace_open_idx" ON "spec_owner_questions" ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_owner_questions_one_open_mismatch_idx" ON "spec_owner_questions" ("spec_id") WHERE kind = 'import_mismatch' AND status = 'open';--> statement-breakpoint
ALTER TABLE "spec_intent_checks" ADD CONSTRAINT "spec_intent_checks_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_owner_questions" ADD CONSTRAINT "spec_owner_questions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_owner_questions" ADD CONSTRAINT "spec_owner_questions_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;