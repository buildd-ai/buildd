-- The duplicate this index forbids is exactly what the bug it fixes produces, so
-- live rows may already violate it. Before enforcing it, collapse any pre-existing
-- duplicates (keep the newest pending reviewer per workspace, PR and head SHA,
-- cancel the rest) so this migration cannot fail-and-freeze prod on a leftover
-- duplicate row. Newest, because review status is read newest-first: keeping an
-- older row would make the PR read as a cancelled review. Pending rows have no
-- worker yet, so cancelling them interrupts nothing. Scoped to exactly the rows
-- the index covers (webhook-filed reviewer rows with a parent task).
UPDATE "tasks" a
SET "status" = 'cancelled', "updated_at" = now()
FROM "tasks" b
WHERE a."status" = 'pending' AND b."status" = 'pending'
  AND a."category" = 'review' AND b."category" = 'review'
  AND a."creation_source" = 'webhook' AND b."creation_source" = 'webhook'
  AND a."parent_task_id" IS NOT NULL AND b."parent_task_id" IS NOT NULL
  AND a."subject_pr_number" IS NOT NULL AND a."subject_head_sha" IS NOT NULL
  AND a."workspace_id" = b."workspace_id"
  AND a."subject_pr_number" = b."subject_pr_number"
  AND a."subject_head_sha" = b."subject_head_sha"
  AND (a."created_at" < b."created_at" OR (a."created_at" = b."created_at" AND a."id" < b."id"));
--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_one_pending_review_per_head_unique" ON "tasks" USING btree ("workspace_id","subject_pr_number","subject_head_sha") WHERE "tasks"."category" = 'review' AND "tasks"."status" = 'pending' AND "tasks"."creation_source" = 'webhook' AND "tasks"."parent_task_id" IS NOT NULL AND "tasks"."subject_pr_number" IS NOT NULL AND "tasks"."subject_head_sha" IS NOT NULL;