-- Every change to an artifact's body (content or storage_key) appends an
-- immutable artifact_revisions row in the same statement as the write.
--
-- Why a trigger: artifacts are written from ~20 call sites (worker, mission,
-- workspace and initiative routes, PATCH, upload-url, auto reports, salvage,
-- migrations). neon-http has no interactive transactions, so an app-side
-- "write body, then write revision" pair can lose the second half, and a new
-- call site could forget it. Here no statement can change a body unrecorded.
--
-- current_revision is owned by this trigger: a writer never sets it, it only
-- compares against it (WHERE current_revision = <expected>) to refuse a lost
-- update. A body written before this migration (current_revision = 0) is
-- snapshotted as revision 1 on its first change, so nothing earlier is lost.
CREATE OR REPLACE FUNCTION artifacts_record_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  next_rev integer;
  writer text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.content IS NULL AND NEW.storage_key IS NULL THEN
      NEW.current_revision := 0;
      RETURN NEW;
    END IF;
    NEW.current_revision := 1;
    RETURN NEW;
  END IF;

  -- UPDATE: the trigger alone moves current_revision.
  NEW.current_revision := OLD.current_revision;
  -- content_author names the writer of THIS statement only: a value carried
  -- over from an earlier write is not this writer's, so it is never recorded.
  writer := CASE WHEN NEW.content_author IS DISTINCT FROM OLD.content_author THEN NEW.content_author END;
  NEW.content_author := NULL;
  IF NEW.content IS NOT DISTINCT FROM OLD.content
     AND NEW.storage_key IS NOT DISTINCT FROM OLD.storage_key THEN
    RETURN NEW;
  END IF;

  next_rev := OLD.current_revision;
  IF OLD.current_revision = 0 AND (OLD.content IS NOT NULL OR OLD.storage_key IS NOT NULL) THEN
    INSERT INTO artifact_revisions (artifact_id, revision, content, storage_key, content_hash, size_bytes, worker_id, author)
    VALUES (
      OLD.id, 1, OLD.content, OLD.storage_key,
      CASE WHEN OLD.content IS NULL THEN NULL ELSE encode(sha256(convert_to(OLD.content, 'UTF8')), 'hex') END,
      CASE WHEN OLD.content IS NULL THEN NULL ELSE octet_length(convert_to(OLD.content, 'UTF8')) END,
      OLD.worker_id, 'legacy'
    )
    ON CONFLICT (artifact_id, revision) DO NOTHING;
    next_rev := 1;
  END IF;

  next_rev := next_rev + 1;
  INSERT INTO artifact_revisions (artifact_id, revision, content, storage_key, content_hash, size_bytes, worker_id, author)
  VALUES (
    NEW.id, next_rev, NEW.content, NEW.storage_key,
    CASE WHEN NEW.content IS NULL THEN NULL ELSE encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') END,
    CASE WHEN NEW.content IS NULL THEN NULL ELSE octet_length(convert_to(NEW.content, 'UTF8')) END,
    NEW.worker_id, writer
  );
  NEW.current_revision := next_rev;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
-- An inserted body is revision 1. Recorded AFTER INSERT so the foreign key
-- holds; the BEFORE trigger above has already set current_revision.
CREATE OR REPLACE FUNCTION artifacts_record_first_revision()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_revision = 1 THEN
    INSERT INTO artifact_revisions (artifact_id, revision, content, storage_key, content_hash, size_bytes, worker_id, author)
    VALUES (
      NEW.id, 1, NEW.content, NEW.storage_key,
      CASE WHEN NEW.content IS NULL THEN NULL ELSE encode(sha256(convert_to(NEW.content, 'UTF8')), 'hex') END,
      CASE WHEN NEW.content IS NULL THEN NULL ELSE octet_length(convert_to(NEW.content, 'UTF8')) END,
      NEW.worker_id, NEW.content_author
    );
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- A revision is history: nothing rewrites it. The one permitted change is
-- filling a hash or size that was NULL (a file body, hashed once its bytes are
-- verified). Deletion stays possible only through the artifact's own cascade.
CREATE OR REPLACE FUNCTION artifact_revisions_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.artifact_id IS DISTINCT FROM OLD.artifact_id
     OR NEW.revision IS DISTINCT FROM OLD.revision
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
     OR NEW.worker_id IS DISTINCT FROM OLD.worker_id
     OR NEW.author IS DISTINCT FROM OLD.author
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.content_hash IS NOT NULL AND NEW.content_hash IS DISTINCT FROM OLD.content_hash)
     OR (OLD.size_bytes IS NOT NULL AND NEW.size_bytes IS DISTINCT FROM OLD.size_bytes) THEN
    RAISE EXCEPTION 'artifact_revisions rows are immutable (artifact %, revision %)', OLD.artifact_id, OLD.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifacts_record_revision ON artifacts;
--> statement-breakpoint
CREATE TRIGGER artifacts_record_revision
  BEFORE INSERT OR UPDATE ON artifacts
  FOR EACH ROW EXECUTE FUNCTION artifacts_record_revision();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifacts_record_first_revision ON artifacts;
--> statement-breakpoint
CREATE TRIGGER artifacts_record_first_revision
  AFTER INSERT ON artifacts
  FOR EACH ROW EXECUTE FUNCTION artifacts_record_first_revision();
--> statement-breakpoint
DROP TRIGGER IF EXISTS artifact_revisions_immutable ON artifact_revisions;
--> statement-breakpoint
CREATE TRIGGER artifact_revisions_immutable
  BEFORE UPDATE ON artifact_revisions
  FOR EACH ROW EXECUTE FUNCTION artifact_revisions_immutable();
