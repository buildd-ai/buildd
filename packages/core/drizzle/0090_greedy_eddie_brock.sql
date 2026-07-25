ALTER TABLE "missions" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "start_resolution" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "start_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "tasks_start_at_idx" ON "tasks" USING btree ("start_at");