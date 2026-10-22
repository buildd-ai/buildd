-- Who a task is for (tasks.created_by_user_id), decided once, at the write.
--
-- Why a trigger: about forty call sites file tasks (retries, reviewers, sweeps,
-- webhooks, the mission loop, the schedule cron, the kernel) and only the main
-- create path named a person. Claim-time code walked parent -> mission ->
-- schedule to find one (core/task-requester.ts), but everything that read the
-- column directly (Health occupancy, the claim-order queue) saw NULL and
-- reported the work as unattributed. A new call site could forget again; here
-- no insert can.
--
-- The walk is the one core/task-requester.ts documents, and nothing more: the
-- writer's own person; else the first parent task (up to 8 hops) that has one;
-- else the creator of the task's mission, then of its schedule (each falling
-- back to the nearest ancestor's). It never uses the claiming runner, the
-- runner's owner, the API key's creator or the team's members: a shared or
-- managed runner does not make its owner the requester, and work no person
-- started stays NULL with requester_source 'none'.
CREATE OR REPLACE FUNCTION tasks_derive_requester(
  p_parent_task_id uuid,
  p_mission_id uuid,
  p_schedule_id uuid,
  OUT user_id uuid,
  OUT source text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  cur uuid := p_parent_task_id;
  mid uuid := p_mission_id;
  sid uuid := p_schedule_id;
  hops integer := 0;
  seen uuid[] := ARRAY[]::uuid[];
  p record;
BEGIN
  WHILE cur IS NOT NULL AND hops < 8 AND NOT (cur = ANY(seen)) LOOP
    seen := seen || cur;
    SELECT t.created_by_user_id, t.parent_task_id, t.mission_id, t.schedule_id
      INTO p FROM tasks t WHERE t.id = cur;
    EXIT WHEN NOT FOUND;
    IF p.created_by_user_id IS NOT NULL THEN
      user_id := p.created_by_user_id;
      source := 'parent';
      RETURN;
    END IF;
    mid := COALESCE(mid, p.mission_id);
    sid := COALESCE(sid, p.schedule_id);
    cur := p.parent_task_id;
    hops := hops + 1;
  END LOOP;

  IF mid IS NOT NULL THEN
    SELECT m.created_by_user_id INTO user_id FROM missions m WHERE m.id = mid;
    IF user_id IS NOT NULL THEN
      source := 'mission';
      RETURN;
    END IF;
  END IF;

  IF sid IS NOT NULL THEN
    SELECT s.created_by_user_id INTO user_id FROM task_schedules s WHERE s.id = sid;
    IF user_id IS NOT NULL THEN
      source := 'schedule';
      RETURN;
    END IF;
  END IF;

  user_id := NULL;
  source := 'none';
END;
$$;
--> statement-breakpoint
-- requester_source is owned by this trigger. On insert it records how the
-- person was decided. When a task is later linked to a parent, mission or
-- schedule it only fills a still-missing person in; it never replaces one
-- already recorded. Nothing in the app rewrites created_by_user_id on an
-- existing task, so that column is not in the UPDATE OF list.
CREATE OR REPLACE FUNCTION tasks_resolve_requester()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.created_by_user_id IS NOT NULL THEN
      NEW.requester_source := 'explicit';
      RETURN NEW;
    END IF;
    SELECT * INTO d FROM tasks_derive_requester(NEW.parent_task_id, NEW.mission_id, NEW.schedule_id);
    NEW.created_by_user_id := d.user_id;
    NEW.requester_source := d.source;
    RETURN NEW;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO d FROM tasks_derive_requester(NEW.parent_task_id, NEW.mission_id, NEW.schedule_id);
  IF d.user_id IS NOT NULL THEN
    NEW.created_by_user_id := d.user_id;
    NEW.requester_source := d.source;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tasks_resolve_requester ON tasks;
--> statement-breakpoint
CREATE TRIGGER tasks_resolve_requester
BEFORE INSERT OR UPDATE OF parent_task_id, mission_id, schedule_id ON tasks
FOR EACH ROW EXECUTE FUNCTION tasks_resolve_requester();
--> statement-breakpoint
-- One-time backfill of rows written before the trigger, by the same walk, plus
-- one corroboration the live path does not need: the derived person must still
-- be a member of the team that owns the task's workspace. A row that fails it
-- is left NULL ('backfill_not_member'), as is one with no person on its chain
-- ('backfill_none'); scripts/audit-task-requesters.ts counts both as
-- exceptions. Nothing is guessed for either.
--
-- Idempotent: only rows with no person and no recorded decision are touched,
-- so a second run finds nothing to do. A row that already names a person keeps
-- it, even where the walk would say otherwise; its requester_source stays NULL
-- because how that person was decided was never recorded. The walk reads the table as it was
-- before this statement, the same answer claim-time resolution gave.
-- (This UPDATE sets no column the trigger watches, so it does not fire.)
UPDATE tasks t
SET created_by_user_id = CASE WHEN tm.user_id IS NOT NULL THEN d.user_id END,
    requester_source = CASE
      WHEN d.user_id IS NULL THEN 'backfill_none'
      WHEN tm.user_id IS NULL THEN 'backfill_not_member'
      ELSE 'backfill_' || d.source
    END
FROM tasks src
CROSS JOIN LATERAL tasks_derive_requester(src.parent_task_id, src.mission_id, src.schedule_id) d
JOIN workspaces w ON w.id = src.workspace_id
LEFT JOIN team_members tm ON tm.team_id = w.team_id AND tm.user_id = d.user_id
WHERE t.id = src.id
  AND t.created_by_user_id IS NULL
  AND t.requester_source IS NULL;
