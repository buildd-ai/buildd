ALTER TABLE "artifacts" ADD COLUMN "mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "artifacts_mission_idx" ON "artifacts" ("mission_id");
