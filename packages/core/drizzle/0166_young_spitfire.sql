ALTER TABLE "tasks" ADD COLUMN "mission_phase_index" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "mission_phase_label" text;--> statement-breakpoint
CREATE INDEX "tasks_mission_phase_idx" ON "tasks" USING btree ("mission_id","mission_phase_index");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_mission_phase_paired" CHECK (("tasks"."mission_phase_index" IS NULL) = ("tasks"."mission_phase_label" IS NULL));