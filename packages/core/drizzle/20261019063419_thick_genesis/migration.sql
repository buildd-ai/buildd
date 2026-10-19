CREATE TABLE "verdict_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"verdict_id" uuid NOT NULL,
	"spec_revision_id" uuid NOT NULL,
	"criterion_id" text NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verdict_evidence_kind" CHECK ("kind" IN ('test', 'task', 'pr', 'commit'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verdict_evidence_item_idx" ON "verdict_evidence" ("verdict_id","kind","ref");--> statement-breakpoint
CREATE INDEX "verdict_evidence_criterion_idx" ON "verdict_evidence" ("spec_revision_id","criterion_id");--> statement-breakpoint
CREATE INDEX "verdict_evidence_ref_idx" ON "verdict_evidence" ("kind","ref");--> statement-breakpoint
ALTER TABLE "verdict_evidence" ADD CONSTRAINT "verdict_evidence_verdict_id_spec_outcome_verdicts_id_fkey" FOREIGN KEY ("verdict_id") REFERENCES "spec_outcome_verdicts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "verdict_evidence" ADD CONSTRAINT "verdict_evidence_spec_revision_id_spec_revisions_id_fkey" FOREIGN KEY ("spec_revision_id") REFERENCES "spec_revisions"("id") ON DELETE CASCADE;