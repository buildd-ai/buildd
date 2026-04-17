ALTER TABLE "tasks" ADD COLUMN "kind" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "complexity" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "predicted_model" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "classified_by" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_kind_idx" ON "tasks" ("kind");