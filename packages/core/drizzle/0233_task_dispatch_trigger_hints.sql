-- Let the statement that makes a task pending tell the trigger WHY, in the
-- same transaction (packages/core/dispatch-outbox.ts `dispatchHintSql`).
--
-- The app sets a transaction-local jsonb hint before the write, in one
-- db.batch: set_config('buildd.dispatch_hint', '{...}', true). The trigger
-- (0231) reads it:
--   cause     the specific DispatchCause, appended to the row's trail, so a
--             plan child is never delivered as a plain new task first
--   metadata  delivery hints (e.g. targetLocalUiUrl) on the row from birth,
--             so a concurrent drain cannot broadcast a targeted task
--   suppress  write no intent: the transition is not new runnable state.
--             The claim route's rollback of its own claim (assigned →
--             pending) is the one user: waking runners there would loop
--             claim → refuse → rollback → wake.
-- No hint, or an unparseable one, behaves exactly as 0231.
CREATE OR REPLACE FUNCTION task_dispatch_outbox_on_pending()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  due timestamptz;
  key text;
  why text;
  hint jsonb;
  hinted_cause text;
  hinted_meta jsonb;
BEGIN
  IF NEW.status <> 'pending' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD.status = 'pending'
     AND OLD.start_at IS NOT DISTINCT FROM NEW.start_at THEN
    RETURN NEW;
  END IF;

  BEGIN
    hint := NULLIF(current_setting('buildd.dispatch_hint', true), '')::jsonb;
  EXCEPTION WHEN others THEN
    hint := NULL;
  END;
  IF jsonb_typeof(hint) <> 'object' THEN
    hint := NULL;
  END IF;
  IF hint ? 'suppress' THEN
    RETURN NEW;
  END IF;
  hinted_cause := NULLIF(hint->>'cause', '');
  hinted_meta := CASE WHEN jsonb_typeof(hint->'metadata') = 'object' THEN hint->'metadata' END;

  IF NEW.start_at IS NOT NULL AND NEW.start_at > now() THEN
    due := NEW.start_at;
    key := 'start_at:' || floor(extract(epoch FROM NEW.start_at) * 1000)::bigint::text;
    why := 'start_at.reached';
  ELSE
    due := now();
    key := 'now';
    why := CASE WHEN TG_OP = 'INSERT' THEN 'task.created' ELSE 'task.requeued' END;
  END IF;

  INSERT INTO task_dispatch_outbox (workspace_id, task_id, cause, causes, not_before, dedupe_key, metadata)
  VALUES (
    NEW.workspace_id, NEW.id, why,
    CASE WHEN hinted_cause IS NULL THEN jsonb_build_array(why) ELSE jsonb_build_array(why, hinted_cause) END,
    due, key, hinted_meta
  )
  ON CONFLICT (task_id, dedupe_key) WHERE status = 'pending'
  DO UPDATE SET
    causes = task_dispatch_outbox.causes || EXCLUDED.causes,
    not_before = LEAST(task_dispatch_outbox.not_before, EXCLUDED.not_before),
    metadata = CASE
      WHEN EXCLUDED.metadata IS NULL THEN task_dispatch_outbox.metadata
      ELSE COALESCE(task_dispatch_outbox.metadata, '{}'::jsonb) || EXCLUDED.metadata
    END,
    updated_at = now();

  RETURN NEW;
END;
$$;
