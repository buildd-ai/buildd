ALTER TABLE "tier_pools" ADD COLUMN "dial" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "tier_pools" ADD COLUMN "dial_state" jsonb;