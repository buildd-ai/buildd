ALTER TABLE "workers" ADD COLUMN "superseded_by_pr_number" integer;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "superseded_by_pr_url" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "superseded_reason" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "superseded_recorded_by" text;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "superseded_at" timestamp with time zone;