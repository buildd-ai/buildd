CREATE TABLE "failure_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"signature" text NOT NULL,
	"detector_version" text NOT NULL,
	"rule" text NOT NULL,
	"reason_code" text NOT NULL,
	"title" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"recurrence_count" integer DEFAULT 0 NOT NULL,
	"affected_refs" jsonb DEFAULT '{"taskIds":[],"workerIds":[],"prNumbers":[]}'::jsonb NOT NULL,
	"evidence_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"impact" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_alerted_at" timestamp with time zone,
	"last_alert_severity" text,
	"linked_fix_task_id" uuid,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "failure_incidents" ADD CONSTRAINT "failure_incidents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "failure_incidents" ADD CONSTRAINT "failure_incidents_linked_fix_task_id_tasks_id_fk" FOREIGN KEY ("linked_fix_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "failure_incidents_signature_version_idx" ON "failure_incidents" USING btree ("signature","detector_version");--> statement-breakpoint
CREATE INDEX "failure_incidents_workspace_status_seen_idx" ON "failure_incidents" USING btree ("workspace_id","status","last_seen_at");