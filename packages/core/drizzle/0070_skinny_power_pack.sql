CREATE TABLE "knowledge_ingest_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repo" text NOT NULL,
	"trigger" text NOT NULL,
	"sha" text,
	"pr_number" integer,
	"scope" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"changed_files" jsonb,
	"stats" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "knowledge_ingest_jobs" ADD CONSTRAINT "knowledge_ingest_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_ingest_jobs_ws_status_idx" ON "knowledge_ingest_jobs" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_ingest_jobs_ws_sha_scope_idx" ON "knowledge_ingest_jobs" USING btree ("workspace_id","sha","scope") WHERE "knowledge_ingest_jobs"."status" != 'error';