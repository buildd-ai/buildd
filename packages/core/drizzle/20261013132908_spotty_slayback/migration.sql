CREATE TABLE "spec_metadata_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"field" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text NOT NULL,
	"changed_by_kind" text NOT NULL,
	"changed_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
ALTER TABLE "specs" ADD COLUMN "repo_copy" jsonb;--> statement-breakpoint
CREATE INDEX "spec_metadata_changes_spec_idx" ON "spec_metadata_changes" ("spec_id","created_at");--> statement-breakpoint
ALTER TABLE "spec_metadata_changes" ADD CONSTRAINT "spec_metadata_changes_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_metadata_changes" ADD CONSTRAINT "spec_metadata_changes_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;