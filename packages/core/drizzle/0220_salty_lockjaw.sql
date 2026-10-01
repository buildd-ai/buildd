ALTER TABLE "accounts" ADD COLUMN "scopes" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "workspace_ids" jsonb;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "last_used_at" timestamp with time zone;