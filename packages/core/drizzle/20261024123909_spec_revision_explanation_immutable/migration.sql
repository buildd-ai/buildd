-- A revision's explanation ("Approving specs from a session" R-15, AC-18) is
-- written with the revision and never changed afterwards: what a person read
-- on the confirm page is what the revision carries. The app has no path that
-- updates it; this trigger makes that true for every statement, so a later
-- call site cannot change one by mistake. Setting it on the inserting
-- statement is the only write.
CREATE OR REPLACE FUNCTION spec_revisions_explanation_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'spec_revisions.explanation is immutable (spec %, revision %)', OLD.spec_id, OLD.revision
    USING ERRCODE = 'check_violation';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS spec_revisions_explanation_immutable ON spec_revisions;
--> statement-breakpoint
CREATE TRIGGER spec_revisions_explanation_immutable
  BEFORE UPDATE OF explanation ON spec_revisions
  FOR EACH ROW
  WHEN (OLD.explanation IS DISTINCT FROM NEW.explanation)
  EXECUTE FUNCTION spec_revisions_explanation_immutable();
