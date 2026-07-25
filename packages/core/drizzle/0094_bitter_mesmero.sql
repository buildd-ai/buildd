ALTER TABLE "missions" ADD COLUMN "pacing_mode" text DEFAULT 'eager' NOT NULL;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "pacing_max_per_hour" integer;--> statement-breakpoint
ALTER TABLE "missions" ADD COLUMN "last_task_started_at" timestamp with time zone;