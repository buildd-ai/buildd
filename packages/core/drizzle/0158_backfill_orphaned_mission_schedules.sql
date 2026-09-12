-- One-time backfill for orphaned mission heartbeat schedules
-- (docs/reports/mission-heartbeat-schedule-lifecycle-audit.md §2).
--
-- `archiveStaleDoneMissions` (apps/web/src/lib/mission-archive.ts) wrote
-- status='archived' via a raw UPDATE that never deleted the mission's
-- `task_schedules` row or cleared `missions.schedule_id`. That code path is
-- fixed going forward in this same change, but `missions.schedule_id` carries
-- no FK (unlike `tasks.schedule_id`, which has ON DELETE SET NULL — see
-- 0035_round_hellfire_club.sql), so nothing ever cleaned up the rows this
-- left behind before the fix. schema.ts is unchanged; this is a one-time data
-- cleanup, not a DDL change.
--
-- Scope: missions in a terminal status only. 'cancelled' is not a real
-- mission status (schema.ts: 'active' | 'paused' | 'completed' | 'archived' |
-- 'budget_exhausted'), so only 'completed' and 'archived' are terminal here.
-- Active missions are left untouched on purpose, including a held/manual
-- mission whose schedule keeps ticking with no completion path — that is a
-- separate defect; deleting its schedule here would only hide it.
--
-- Idempotent: safe to re-run, matches nothing on a second pass.

DO $$
DECLARE
  removed_count integer;
BEGIN
  WITH orphaned AS (
    SELECT m.id AS mission_id, m.schedule_id
    FROM "missions" m
    WHERE m.status IN ('completed', 'archived')
      AND m.schedule_id IS NOT NULL
  ),
  cleared_missions AS (
    UPDATE "missions" m
    SET schedule_id = NULL
    FROM orphaned o
    WHERE m.id = o.mission_id
  )
  DELETE FROM "task_schedules" ts
  USING orphaned o
  WHERE ts.id = o.schedule_id;

  GET DIAGNOSTICS removed_count = ROW_COUNT;
  RAISE NOTICE 'mission-heartbeat backfill: removed % orphaned task_schedules row(s)', removed_count;
END $$;
