ALTER TABLE "mission_notes" ADD COLUMN "disposition" text;--> statement-breakpoint
-- Needs You admission (packages/core/needs-you.ts) requires a
-- human-attention disposition on every park and on every agent/outside-caller
-- question note. Everything parked or posted before that rule existed was
-- shown to a person as an ask, so it is stamped as one ('backfill' records
-- that no gate decided it). A held question already carries 'hold' and is left
-- alone. Idempotent: only rows with no disposition are touched.
UPDATE "workers"
SET "waiting_for" = "waiting_for" || jsonb_build_object(
  'disposition', 'ask',
  'dispositionBy', CASE WHEN "waiting_for"->>'type' = 'question' THEN 'backfill' ELSE 'permission' END
)
WHERE "waiting_for" IS NOT NULL
  AND jsonb_typeof("waiting_for") = 'object'
  AND "waiting_for"->>'disposition' IS NULL;--> statement-breakpoint
UPDATE "mission_notes"
SET "disposition" = 'ask'
WHERE "type" = 'question'
  AND "author_type" IN ('agent', 'mcp')
  AND "disposition" IS NULL;
