ALTER TABLE "secrets" ADD COLUMN "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last_failure_message" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "consecutive_auth_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last_success_at" timestamp with time zone;