ALTER TABLE "workers" ADD COLUMN "abandoned_reason" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "abandoned_recorded_by" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "abandoned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "supersession_scan" jsonb;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "supersession_scanned_at" timestamp with time zone;