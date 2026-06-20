ALTER TABLE "secrets" ADD COLUMN "last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last_verification_error" text;
