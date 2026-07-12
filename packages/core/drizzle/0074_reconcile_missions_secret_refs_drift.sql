-- Reconciliation migration for the Schema Drift / check-prod gate on release PR #1184.
--
-- Root cause (confirmed by direct read-only introspection of production + git archaeology,
-- NOT a case of manual DDL applied ahead of schema.ts):
--
-- 1. `secret_refs` was intentionally dropped in migration 0021_faithful_warbound.sql
--    (commit 771a349c, "refactor: remove secret_refs table and ref-based credential
--    delivery"). It never got recreated in schema.ts.
--
-- 2. The `objectives` table's cron_expression / is_heartbeat / heartbeat_checklist /
--    active_hours_start / active_hours_end / active_hours_timezone / default_role_slug
--    columns were intentionally dropped in migration 0022_mixed_mastermind.sql
--    (commit a942ee2e, PR #486, "drop redundant fields from objectives table (Phase 3)")
--    after their data was migrated into the linked taskSchedules row's
--    taskTemplate.context JSON. `objectives` was later renamed to `missions`
--    (commit 14262d6d), which is why production shows these as `missions.*` columns
--    rather than `objectives.*`.
--
-- Both drops were correctly generated and committed. Neither ever ran in production.
-- Cause: migration 0020_data_fix_is_role.sql has journal `when`=1773886800000, while
-- 0021 (1773749254048) and 0022 (1773882537172) — which come AFTER it in apply order —
-- both have a lower `when`. Drizzle's migrator applies only entries whose `when` exceeds
-- the highest `when` already recorded as applied, so once 0020 applied, 0021 and 0022
-- sat below that high-water-mark and were silently skipped on every subsequent deploy.
-- This is the same bug class as the 0067_tasks_path_manifest incident fixed in PR #1150
-- (see docs/design/migration-doctrine.md) — except here the skip left production BEHIND
-- (stale columns/table not removed) rather than missing a new column.
--
-- Editing 0021/0022 in place and re-timestamping them is not safe: 0022's DROP COLUMN
-- statements target the pre-rename table name "objectives", which no longer exists in
-- production (the rename migration DID apply). This migration instead re-issues the
-- equivalent, idempotent DDL against the current table name so it is safe to run
-- regardless of what has or hasn't already landed in any given environment.
--
-- schema.ts is NOT changed by this PR — it already correctly omits all of the columns/
-- table below; production is what needs to catch up.

DROP TABLE IF EXISTS "secret_refs";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "cron_expression";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "is_heartbeat";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "heartbeat_checklist";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "active_hours_start";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "active_hours_end";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "active_hours_timezone";--> statement-breakpoint
ALTER TABLE "missions" DROP COLUMN IF EXISTS "default_role_slug";
