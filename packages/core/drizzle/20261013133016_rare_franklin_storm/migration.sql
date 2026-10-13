CREATE TABLE "spec_filings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"spec_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"previous_parent_id" uuid,
	"parent_spec_id" uuid,
	"source" text NOT NULL,
	"proposal" jsonb,
	"decision_record_id" uuid,
	"batch_id" uuid,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_by" text,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "spec_filings_spec_idx" ON "spec_filings" ("spec_id","created_at");--> statement-breakpoint
CREATE INDEX "spec_filings_workspace_status_idx" ON "spec_filings" ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "spec_filings" ADD CONSTRAINT "spec_filings_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_filings" ADD CONSTRAINT "spec_filings_spec_id_specs_id_fkey" FOREIGN KEY ("spec_id") REFERENCES "specs"("id") ON DELETE CASCADE;