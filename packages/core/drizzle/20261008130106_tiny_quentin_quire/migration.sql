ALTER TABLE "workers" ADD COLUMN "cost_basis" text;--> statement-breakpoint
-- Backfill workers.cost_basis for rows recorded before reporters sent one
-- (docs/specs/real-and-virtual-cost.md, "Historic rows").
--
-- Before this column existed, the deployment's usage ran on plan logins,
-- except cloud-runner runs, which were charged per token. Cloud-runner runs
-- are `--once` runs and register as `headless://<host>/once/<taskId>`
-- (apps/runner/src/run-once.ts), so that shape is real and every other row
-- with usage is virtual. Rows with no usage stay NULL: there is nothing to
-- classify. Idempotent: only NULL rows are touched.
UPDATE "workers"
SET "cost_basis" = CASE
  WHEN "runner" LIKE 'headless://%/once/%' THEN 'real'
  ELSE 'virtual'
END
WHERE "cost_basis" IS NULL
  AND ("cost_usd" > 0 OR "input_tokens" > 0 OR "output_tokens" > 0);
