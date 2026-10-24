-- A revision's explanation ("Approving specs from a session" R-15, AC-18) is
-- written with the revision and never changed afterwards: what a person read
-- on the confirm page is what the revision carries. The app has no path that
-- updates it; this trigger makes that true for every statement, so a later
-- call site cannot change one by mistake. Setting it on the inserting
-- statement is the only write.
--
-- Shaped like artifact_revisions_immutable (20261010170119): an unconditional
-- BEFORE UPDATE trigger with the comparison inside the function, not
-- `UPDATE OF explanation ... WHEN (...)`. Every other write to this row
-- (criteria_count, approved_at, approval, ...) leaves explanation untouched,
-- so NEW.explanation always equals OLD.explanation there and the trigger is a
-- no-op; it only raises when a statement actually sets a different value.
CREATE OR REPLACE FUNCTION spec_revisions_explanation_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.explanation IS DISTINCT FROM OLD.explanation THEN
    RAISE EXCEPTION 'spec_revisions.explanation is immutable (spec %, revision %)', OLD.spec_id, OLD.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS spec_revisions_explanation_immutable ON spec_revisions;
--> statement-breakpoint
CREATE TRIGGER spec_revisions_explanation_immutable
  BEFORE UPDATE ON spec_revisions
  FOR EACH ROW EXECUTE FUNCTION spec_revisions_explanation_immutable();
