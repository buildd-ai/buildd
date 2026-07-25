ALTER TABLE "mission_notes" ALTER COLUMN "mission_id" DROP NOT NULL;--> statement-breakpoint
CREATE INDEX "mission_notes_task_idx" ON "mission_notes" USING btree ("task_id");