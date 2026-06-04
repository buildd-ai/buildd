ALTER TABLE "accounts" ADD COLUMN "monthly_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "monthly_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "monthly_cost_month" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "budget_alerts_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;