ALTER TABLE "workers" ADD COLUMN "pr_last_verified_at" timestamp with time zone;--> statement-breakpoint
-- Backfill, deliberately NOT a blanket copy of pr_last_checked_at: that column
-- was advanced on a failed check too (recordFailure -> recordCheck), so copying
-- it everywhere would launder every currently-poisoned row as verified and
-- reproduce the exact bug this migration exists to fix, just moved one column
-- over. A row backfills to a real timestamp only where prLastCheckedAt already
-- represents a confirmed GitHub answer: no failures ever recorded, or the
-- lifecycle reached a terminal state (merged/closed/unresolvable) that GitHub
-- itself is agreed on. Everything else lands NULL and correctly renders
-- STALE/unverified until the sweep confirms it fresh.
UPDATE "workers"
SET "pr_last_verified_at" = "pr_last_checked_at"
WHERE "pr_last_checked_at" IS NOT NULL
  AND (
    COALESCE("pr_check_failure_count", 0) = 0
    OR "pr_lifecycle_status" IN ('merged', 'closed', 'unresolvable')
  );