-- task_subject_claims.released_at is dropped: nothing ever wrote it. Supersession
-- rotates the claim row in place (see rotateClaim in subject-intake-db.ts), which
-- preserves the retry-chain links a release-and-reinsert would discard, so there is
-- no code path that retires a claim and no timestamp to record. IF EXISTS keeps a
-- re-run harmless.
ALTER TABLE "task_subject_claims" DROP COLUMN IF EXISTS "released_at";
