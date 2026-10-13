CREATE TABLE "incident_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"incident_id" uuid,
	"source" text NOT NULL,
	"signature" text,
	"fingerprint" text,
	"subject_anchor" jsonb,
	"title" text NOT NULL,
	"excerpt" text,
	"refs" jsonb DEFAULT '{}' NOT NULL,
	"reporter_task_id" uuid,
	"reporter_account_id" uuid,
	"decision" text,
	"decided_by" text,
	"reason_code" text,
	"confidence" numeric(4,3),
	"decision_record_id" uuid,
	"moved_from_incident_id" uuid,
	"moved_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "failure_incidents" ADD COLUMN "trace" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_reports_workspace_idempotency_idx" ON "incident_reports" ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "incident_reports_workspace_signature_idx" ON "incident_reports" ("workspace_id","signature");--> statement-breakpoint
CREATE INDEX "incident_reports_workspace_fingerprint_idx" ON "incident_reports" ("workspace_id","fingerprint");--> statement-breakpoint
CREATE INDEX "incident_reports_incident_created_idx" ON "incident_reports" ("incident_id","created_at");--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_incident_id_failure_incidents_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "failure_incidents"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "incident_reports" ADD CONSTRAINT "incident_reports_decision_record_id_decision_records_id_fkey" FOREIGN KEY ("decision_record_id") REFERENCES "decision_records"("id") ON DELETE SET NULL;