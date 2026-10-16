ALTER TABLE "spec_outcome_verdicts" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "spec_outcome_verdicts_mission_idx" ON "spec_outcome_verdicts" ("mission_id","spec_revision_id","criterion_id","created_at") WHERE mission_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD CONSTRAINT "spec_outcome_verdicts_mission_id_missions_id_fkey" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "spec_outcome_verdicts" ADD CONSTRAINT "spec_outcome_verdicts_one_subject" CHECK (("task_id" IS NULL) <> ("mission_id" IS NULL));