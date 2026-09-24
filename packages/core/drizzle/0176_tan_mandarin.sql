-- The duplicate this index forbids is exactly what the bug it fixes produces, so
-- live rows may already violate it. Before enforcing it, collapse any pre-existing
-- duplicates (keep the newest pending webhook CI retry per PR, cancel the rest) so
-- this migration cannot fail-and-freeze prod on a leftover duplicate row. Pending
-- rows have no worker yet, so cancelling them interrupts nothing.
UPDATE "tasks" a
SET "status" = 'cancelled', "updated_at" = now()
FROM "tasks" b
WHERE a."status" = 'pending' AND b."status" = 'pending'
  AND a."creation_source" = 'webhook' AND b."creation_source" = 'webhook'
  AND a."ci_retry_pr_number" IS NOT NULL
  AND a."workspace_id" = b."workspace_id"
  AND a."ci_retry_pr_number" = b."ci_retry_pr_number"
  AND (a."created_at" < b."created_at" OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_pending_ci_retry_per_pr_unique" ON "tasks" USING btree ("workspace_id","ci_retry_pr_number") WHERE "tasks"."status" = 'pending' AND "tasks"."creation_source" = 'webhook' AND "tasks"."ci_retry_pr_number" IS NOT NULL;
