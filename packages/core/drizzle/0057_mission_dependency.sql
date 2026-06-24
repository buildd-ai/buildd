ALTER TABLE "missions" ADD COLUMN "depends_on_mission_id" uuid;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "gate_condition" text DEFAULT 'merged' NOT NULL;
--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "dependency_met_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "missions_depends_on_idx" ON "missions" USING btree ("depends_on_mission_id");
