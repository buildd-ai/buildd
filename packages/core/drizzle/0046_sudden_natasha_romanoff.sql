ALTER TABLE "secrets" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "last_refreshed_at" timestamp with time zone;