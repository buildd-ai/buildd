CREATE TABLE "workflow_scope_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"mission_id" uuid NOT NULL,
	"source_task_id" uuid,
	"decision" text NOT NULL,
	"status" text NOT NULL,
	"scope_version_before" integer NOT NULL,
	"scope_version_after" integer,
	"before" jsonb,
	"after" jsonb,
	"weakens" jsonb,
	"reason" text,
	"decision_fact_id" uuid,
	"decider_id" text,
	"confidence" real,
	"fallback" text,
	"actor" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "scope_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_scope_amendments_task_unique" ON "workflow_scope_amendments" ("mission_id","source_task_id");--> statement-breakpoint
CREATE INDEX "workflow_scope_amendments_mission_idx" ON "workflow_scope_amendments" ("mission_id","created_at");--> statement-breakpoint
ALTER TABLE "workflow_scope_amendments" ADD CONSTRAINT "workflow_scope_amendments_mission_id_missions_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workflow_scope_amendments" ADD CONSTRAINT "workflow_scope_amendments_source_task_id_tasks_id_fkey" FOREIGN KEY ("source_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL;