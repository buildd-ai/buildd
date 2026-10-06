ALTER TABLE "teams" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "billing_status" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "paid_seats" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "teams_stripe_customer_id_idx" ON "teams" USING btree ("stripe_customer_id");