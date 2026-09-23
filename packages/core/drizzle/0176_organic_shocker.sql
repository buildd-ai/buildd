-- The duplicate this index forbids is exactly what the bug it fixes produces, so
-- live rows may already violate it. Before enforcing it, collapse any pre-existing
-- duplicates (keep the newest pending attempt per parent, cancel the rest) so this
-- migration cannot fail-and-freeze prod on a leftover duplicate row. Pending rows
-- have no worker yet, so cancelling them interrupts nothing.
UPDATE "tasks" a
SET "status" = 'cancelled', "updated_at" = now()
FROM "tasks" b
WHERE a."status" = 'pending' AND b."status" = 'pending'
  AND a."task_class" = 'attempt' AND b."task_class" = 'attempt'
  AND a."creation_source" = 'webhook' AND b."creation_source" = 'webhook'
  AND a."parent_task_id" IS NOT NULL
  AND a."workspace_id" = b."workspace_id"
  AND a."parent_task_id" = b."parent_task_id"
  AND (a."created_at" < b."created_at" OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_open_attempt_per_parent_unique" ON "tasks" USING btree ("workspace_id","parent_task_id") WHERE "tasks"."status" = 'pending' AND "tasks"."task_class" = 'attempt' AND "tasks"."creation_source" = 'webhook' AND "tasks"."parent_task_id" IS NOT NULL;
