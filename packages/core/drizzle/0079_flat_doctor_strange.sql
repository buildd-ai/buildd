ALTER TYPE "public"."connector_auth_mode" ADD VALUE IF NOT EXISTS 'assertion';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "assertion_audience" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN IF NOT EXISTS "assertion_token_endpoint" text;