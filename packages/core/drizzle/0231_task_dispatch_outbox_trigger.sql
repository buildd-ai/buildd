-- Every transition INTO `pending` writes a durable dispatch intent in the same
-- transaction as the write itself (packages/core/dispatch-outbox.ts).
--
-- Why a trigger: tasks reach `pending` from dozens of call sites (creation,
-- auto-retry, reviewer/CI fix rounds, reassign, manual reset, plan children,
-- requeue after a reaped worker). neon-http has no interactive transactions, so
-- an app-side "write task, then write intent" pair can lose the second half.
-- Here it cannot: no statement can make a task pending without this row.
--
-- A future `start_at` becomes the row's `not_before`, keyed on the due time so
-- an immediate wake for the same task does not absorb it. Rows for one task
-- coalesce while pending; the app appends its own, more specific cause to the
-- same row (see enqueueDispatchSql).
--
-- Transitions that keep a task pending but make it runnable (a dependency
-- resolving, a path claim releasing) are not visible here; those enqueue
-- explicitly in the statement that makes them.
CREATE OR REPLACE FUNCTION task_dispatch_outbox_on_pending()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  due timestamptz;
  key text;
  why text;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'pending'
     AND OLD.start_at IS NOT DISTINCT FROM NEW.start_at THEN
    RETURN NEW;
  END IF;

  IF NEW.start_at IS NOT NULL AND NEW.start_at > now() THEN
    due := NEW.start_at;
    key := 'start_at:' || floor(extract(epoch FROM NEW.start_at) * 1000)::bigint::text;
    why := 'start_at.reached';
  ELSE
    due := now();
    key := 'now';
    why := CASE WHEN TG_OP = 'INSERT' THEN 'task.created' ELSE 'task.requeued' END;
  END IF;

  INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, not_before, dedupe_key)
  VALUES (NEW.workspace_id, NEW.id, why, jsonb_build_array(why), due, key)
  ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
  DO UPDATE SET
    causes = task_dispatch_outbox.causes || jsonb_build_array(EXCLUDED.cause),
    not_before = LEAST(task_dispatch_outbox.not_before, EXCLUDED.not_before),
    updated_at = now();

  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS task_dispatch_outbox_on_pending ON tasks;
--> statement-breakpoint
CREATE TRIGGER task_dispatch_outbox_on_pending
  AFTER INSERT OR UPDATE OF status, start_at ON tasks
  FOR EACH ROW EXECUTE FUNCTION task_dispatch_outbox_on_pending();
