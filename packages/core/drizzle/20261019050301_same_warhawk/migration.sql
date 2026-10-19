CREATE TABLE "verdict_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"verdict_id" uuid NOT NULL,
	"spec_criterion_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"verified_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdict_criteria_verified_by" CHECK ("verified_by" IN ('test', 'review', 'baseline'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verdict_criteria_verdict_idx" ON "verdict_criteria" ("verdict_id");--> statement-breakpoint
CREATE INDEX "verdict_criteria_criterion_idx" ON "verdict_criteria" ("spec_revision_id","criterion_id","verified_by");--> statement-breakpoint
CREATE INDEX "verdict_criteria_spec_criterion_idx" ON "verdict_criteria" ("spec_criterion_id");--> statement-breakpoint
ALTER TABLE "verdict_criteria" ADD CONSTRAINT "verdict_criteria_verdict_id_spec_outcome_verdicts_id_fkey" FOREIGN KEY ("verdict_id") REFERENCES "spec_outcome_verdicts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verdict_criteria" ADD CONSTRAINT "verdict_criteria_spec_criterion_id_spec_criteria_id_fkey" FOREIGN KEY ("spec_criterion_id") REFERENCES "spec_criteria"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verdict_criteria" ADD CONSTRAINT "verdict_criteria_spec_revision_id_spec_revisions_id_fkey" FOREIGN KEY ("spec_revision_id") REFERENCES "spec_revisions"("id") ON DELETE CASCADE;