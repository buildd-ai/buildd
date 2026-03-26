ALTER TABLE "artifacts" ADD COLUMN IF NOT EXISTS "mission_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_mission_id_fk" FOREIGN KEY ("mission_id") REFERENCES "missions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "artifacts_mission_idx" ON "artifacts" ("mission_id");
