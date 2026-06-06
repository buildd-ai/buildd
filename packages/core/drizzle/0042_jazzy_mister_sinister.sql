ALTER TABLE "teams" ADD COLUMN "monthly_budget_usd" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "monthly_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "monthly_cost_month" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "budget_alerts_sent" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Backfill team monthly_budget_usd from the highest account cap within each team.
-- This seeds the team-level cap from the existing per-account values (e.g. coder-workspace at $100).
UPDATE "teams"
SET "monthly_budget_usd" = sub.max_budget
FROM (
  SELECT "team_id", MAX("monthly_budget_usd") AS max_budget
  FROM "accounts"
  WHERE "monthly_budget_usd" IS NOT NULL
  GROUP BY "team_id"
) sub
WHERE "teams"."id" = sub."team_id";