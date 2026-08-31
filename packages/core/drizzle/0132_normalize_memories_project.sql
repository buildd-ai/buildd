-- Normalize memories.project to the canonical scope key: lowercase `owner/repo`.
--
-- The same logical project was stored four ways — full HTTPS URL, URL with a
-- `.git` suffix, `owner/repo`, and a bare repo name — so per-project scoping
-- matched nothing whenever the workspace and the memory disagreed on the shape.
--
-- Two steps, deliberately separate:
--   1. pure string canonicalization, mirroring normalizeProject() in
--      packages/core/project-scope.ts;
--   2. a team-scoped data repair for bare repo names, driven by a join against
--      `workspaces` — NOT part of the helper, which stays pure and team-agnostic.
--
-- The logic lives in a temporary SQL function rather than being pasted twice, so
-- there is exactly one definition to keep in sync with the TS helper. The
-- function is dropped again at the end. `packages/core/__tests__/project-scope.test.ts`
-- is the specification for both.
--
-- `updated_at` is intentionally NOT touched by either step: it drives the memory
-- list ordering and the LIMIT/OFFSET tiebreaker, and stamping every row with the
-- same instant would destroy that ordering.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION buildd_normalize_project_v1(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Returns lowercase `owner/repo`, or NULL when the input is not repo-shaped
  -- (a bare repo name, a sentinel scope label, blank, or NULL).
  SELECT lower((regexp_match(s, '^([^/]+/[^/]+)'))[1])
  FROM (
    SELECT
      -- 5. schemeless host (`github.com/owner/repo`), only when two segments follow
      regexp_replace(
        -- 4. collapse duplicate slashes, then drop any leading slash
        regexp_replace(
          regexp_replace(
            -- 3. scp-style remote (`git@github.com:owner/repo`)
            regexp_replace(
              -- 2. scheme + optional userinfo + host (`https://github.com/`)
              regexp_replace(
                -- 1. trailing slashes, then a `.git` suffix, then what it hid
                regexp_replace(
                  regexp_replace(
                    regexp_replace(btrim(input), '/+$', ''),
                    '\.git$', '', 'i'
                  ),
                  '/+$', ''
                ),
                '^[a-zA-Z][a-zA-Z0-9+.-]*://([^@/]+@)?[^/]+/', ''
              ),
              '^[^@/[:space:]]+@[^:/[:space:]]+:', ''
            ),
            '/{2,}', '/', 'g'
          ),
          '^/+', ''
        ),
        '^[^/]+\.[^/]+/(?=[^/]+/)', ''
      ) AS s
  ) t;
$$;--> statement-breakpoint
-- Step 1 — canonicalize every repo-shaped value.
--
-- Conservative by construction: the function yields NULL for anything that is not
-- repo-shaped, and those rows are skipped. Sentinel scope labels, values that name
-- an application rather than a repository, and NULL are left byte-identical. Bare
-- repo names are handled by step 2, not here.
--
-- Idempotent: after one run each candidate already equals its canonical form, so
-- the `<> project` guard makes a second run a no-op.
UPDATE "memories"
SET "project" = buildd_normalize_project_v1("project")
WHERE "project" IS NOT NULL
  AND buildd_normalize_project_v1("project") IS NOT NULL
  AND buildd_normalize_project_v1("project") <> "project";--> statement-breakpoint
-- Step 2 — resolve bare repo names against the team's own workspaces.
--
-- A bare repo name carries no owner, so the helper cannot canonicalize it and must
-- not guess. But the owner IS recoverable without guessing when the memory's OWN
-- team has exactly one workspace whose repo basename matches: that is a fact in
-- the data, not an inference.
--
-- Driven by a join against `workspaces` rather than a hardcoded id list, so it
-- stays correct if the data shifts between now and when this is applied.
--
-- Ambiguity is never resolved: `HAVING count(DISTINCT w.norm) = 1` skips any
-- (team, bare name) pair that matches two different owners. Anything with no
-- matching workspace in its own team is left untouched — sentinel labels, values
-- that name an application rather than a repository, and bare names belonging to
-- teams that have no workspace with that basename.
--
-- Idempotent: the rewritten values contain a slash, so the `NOT LIKE '%/%'`
-- filter excludes them on any later run.
WITH ws AS (
  SELECT
    w."team_id",
    -- Mirrors workspaceProjectKey(): prefer repo, fall back to name.
    COALESCE(
      buildd_normalize_project_v1(w."repo"),
      buildd_normalize_project_v1(w."name")
    ) AS norm
  FROM "workspaces" w
), ws_named AS (
  SELECT "team_id", norm, split_part(norm, '/', 2) AS base
  FROM ws
  WHERE norm IS NOT NULL
), bare AS (
  SELECT DISTINCT
    m."team_id",
    m."project",
    lower(btrim(m."project")) AS key
  FROM "memories" m
  WHERE m."project" IS NOT NULL
    AND m."project" NOT LIKE '%/%'
), resolved AS (
  SELECT b."team_id", b."project", min(w.norm) AS norm
  FROM bare b
  JOIN ws_named w
    ON w."team_id" = b."team_id"
   AND w.base = b.key
  GROUP BY b."team_id", b."project"
  HAVING count(DISTINCT w.norm) = 1
)
UPDATE "memories" m
SET "project" = r.norm
FROM resolved r
WHERE m."team_id" = r."team_id"
  AND m."project" = r."project"
  AND m."project" <> r.norm;--> statement-breakpoint
DROP FUNCTION IF EXISTS buildd_normalize_project_v1(text);
