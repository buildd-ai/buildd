-- Mark existing personal teams. Sign-up creates a user's personal team with
-- the slug personal-<user id> and makes that user its owner, so a team is
-- marked only when both hold: the slug names an existing user AND that user
-- holds an owner membership on it. A team whose slug merely carries the
-- prefix is left unmarked. Idempotent: only unmarked teams are touched, and a
-- user who already has a marked team is skipped.
UPDATE "teams" AS t
SET "personal_user_id" = u."id"
FROM "users" AS u
WHERE t."slug" = 'personal-' || u."id"::text
  AND t."personal_user_id" IS NULL
  AND EXISTS (
    SELECT 1 FROM "team_members" AS m
    WHERE m."team_id" = t."id" AND m."user_id" = u."id" AND m."role" = 'owner'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "teams" AS p WHERE p."personal_user_id" = u."id"
  );
