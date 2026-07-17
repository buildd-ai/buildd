ALTER TYPE "public"."connector_auth_mode" ADD VALUE 'assertion';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "assertion_audience" text;--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "assertion_token_endpoint" text;