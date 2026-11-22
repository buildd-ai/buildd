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
ALTER TABLE "spec_revisions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_intent_checks_spec_revision_idx" ON "spec_intent_checks" ("spec_id","revision");--> statement-breakpoint
ALTER TABLE "spec_intent_checks" ADD CONSTRAINT "spec_intent_checks_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;