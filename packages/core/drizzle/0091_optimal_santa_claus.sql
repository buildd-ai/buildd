ALTER TABLE "tasks" ADD COLUMN "loop_config" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "loop_iteration" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "loop_state" text;