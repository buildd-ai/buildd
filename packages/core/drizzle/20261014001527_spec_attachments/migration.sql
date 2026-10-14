CREATE TABLE "spec_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"caption" text,
	"added_in_revision" integer NOT NULL,
	"removed_from_revision" integer,
	"added_by" text NOT NULL,
	"removed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "spec_attachments_kind" CHECK ("kind" IN ('binding', 'reference'))
);
--> statement-breakpoint
ALTER TABLE "spec_revisions" ADD COLUMN "approved_attachments" jsonb;--> statement-breakpoint
CREATE INDEX "spec_attachments_spec_idx" ON "spec_attachments" ("spec_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "spec_attachments_live_name_idx" ON "spec_attachments" ("spec_id","name") WHERE removed_from_revision IS NULL;--> statement-breakpoint
ALTER TABLE "spec_attachments" ADD CONSTRAINT "spec_attachments_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_attachments" ADD CONSTRAINT "spec_attachments_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_attachments" ADD CONSTRAINT "spec_attachments_artifact_id_artifacts_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE;