CREATE TABLE "spec_verdict_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"task_id" uuid,
	"mission_id" uuid,
	"spec_revision_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"source" text NOT NULL,
	"verdict_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"overridden_reviews" integer DEFAULT 0 NOT NULL,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "spec_verdict_sources_one_subject" CHECK (("task_id" IS NULL) <> ("mission_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "spec_verdict_sources_task_unique" ON "spec_verdict_sources" ("task_id","spec_revision_id","criterion_id") WHERE task_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "spec_verdict_sources_mission_unique" ON "spec_verdict_sources" ("mission_id","spec_revision_id","criterion_id") WHERE mission_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_verdict_sources" ADD CONSTRAINT "spec_verdict_sources_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_verdict_sources" ADD CONSTRAINT "spec_verdict_sources_task_id_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_verdict_sources" ADD CONSTRAINT "spec_verdict_sources_mission_id_missions_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_verdict_sources" ADD CONSTRAINT "spec_verdict_sources_spec_revision_id_spec_revisions_id_fkey" FOREIGN KEY ("spec_revision_id") REFERENCES "spec_revisions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_verdict_sources" ADD CONSTRAINT "spec_verdict_sources_verdict_id_spec_outcome_verdicts_id_fkey" FOREIGN KEY ("verdict_id") REFERENCES "spec_outcome_verdicts"("id") ON DELETE CASCADE;