CREATE TABLE "spec_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"anchor_kind" text NOT NULL,
	"anchor_id" text NOT NULL,
	"anchor_label" text NOT NULL,
	"anchor_hash" text NOT NULL,
	"body" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"parent_comment_id" uuid,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "spec_comments_spec_idx" ON "spec_comments" ("spec_id","created_at");--> statement-breakpoint
ALTER TABLE "spec_comments" ADD CONSTRAINT "spec_comments_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_comments" ADD CONSTRAINT "spec_comments_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_comments" ADD CONSTRAINT "spec_comments_spec_revision_id_spec_revisions_id_fkey" FOREIGN KEY ("spec_revision_id") REFERENCES "spec_revisions"("id") ON DELETE CASCADE;