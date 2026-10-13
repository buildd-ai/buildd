CREATE TABLE "spec_outcome_verdicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"verdict" text NOT NULL,
	"head_sha" text,
	"evidence" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD COLUMN "spec_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD CONSTRAINT "spec_outcome_verdicts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD CONSTRAINT "spec_outcome_verdicts_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD CONSTRAINT "spec_outcome_verdicts_spec_revision_id_spec_revisions_id_fk" FOREIGN KEY ("spec_revision_id") REFERENCES "public"."spec_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "spec_outcome_verdicts_task_idx" ON "spec_outcome_verdicts" USING btree ("task_id","spec_revision_id","criterion_id","created_at");--> statement-breakpoint
ALTER TABLE "spec_discrepancies" ADD CONSTRAINT "spec_discrepancies_spec_revision_id_spec_revisions_id_fk" FOREIGN KEY ("spec_revision_id") REFERENCES "public"."spec_revisions"("id") ON DELETE set null ON UPDATE no action;