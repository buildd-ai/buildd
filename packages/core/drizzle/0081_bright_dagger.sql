ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "health_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "last_failure_message" text;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "consecutive_auth_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone;