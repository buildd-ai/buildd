-- Fail the Visual QA job unless scripts/qa/scrub-pii.sql left only placeholders.
-- Runs after the scrub and before the app boots; a failure here means no
-- screenshots are taken and nothing is uploaded.
--
--   psql -v ids="$NO_PROD_DATA_IDENTIFIERS" -f scripts/qa/scrub-guard.sql
--
-- Two checks:
--   1. Sampled rendered columns must match their placeholder shape.
--   2. No text/varchar/json/array column in any public table may match the
--      identifier pattern (the NO_PROD_DATA_IDENTIFIERS secret).
-- Errors name table.column only. Never row content, counts or the pattern.

\set ON_ERROR_STOP on
\set QUIET on

-- psql does not interpolate inside dollar quotes, so hand the pattern over as
-- a session setting. An unset -v ids leaves `:'ids'` literal: a syntax error,
-- which fails the job (fail closed).
SET qa.ids = :'ids';

DO $guard$
DECLARE
  ids text;
  bad text[] := '{}';
  r record;
  hit boolean;
  cond text;
  lorem constant text := '^[a-z ]*$';
BEGIN
  -- 1. Placeholder shapes -----------------------------------------------------
  FOR r IN SELECT * FROM (VALUES
    ('users', 'email', '^(ci-qa@buildd\.dev|user-[0-9a-f]{32}@scrubbed\.local)$'),
    ('users', 'name', '^(CI QA User|User [0-9a-f]{8})$'),
    ('team_invitations', 'email', '^invite-[0-9a-f]{32}@scrubbed\.local$'),
    ('teams', 'name', '^Team [0-9]+$'),
    ('teams', 'slug', '^team-[0-9]+$'),
    ('accounts', 'name', '^Account [0-9]+$'),
    ('workspaces', 'name', '^Workspace [0-9]+$'),
    ('workspaces', 'repo', '^https://github\.com/org-[0-9]+/repo-[0-9]+$'),
    ('github_repos', 'full_name', '^org-[0-9]+/repo-[0-9]+$'),
    ('github_repos', 'owner', '^org-[0-9]+$'),
    ('github_repos', 'description', lorem),
    ('github_installations', 'account_login', '^org-[0-9]+$'),
    ('initiatives', 'title', '^Initiative [0-9]+: [a-z ]*$'),
    ('missions', 'title', '^Mission [0-9]+: [a-z ]*$'),
    ('missions', 'description', lorem),
    ('missions', 'primary_pr_url', '^https://github\.com/org-1/repo-1(/pull/[0-9]+)?$'),
    ('tasks', 'title', '^Task [0-9]+: [a-z ]*$'),
    ('tasks', 'description', lorem),
    ('workers', 'branch', '^buildd/[0-9a-f]{8}-task-[0-9]+$'),
    ('workers', 'pr_url', '^https://github\.com/org-1/repo-1(/pull/[0-9]+)?$'),
    ('workers', 'current_action', lorem),
    ('workers', 'error', '^Error: [a-z ]*$'),
    ('workers', 'pending_instructions', lorem),
    ('mission_notes', 'title', '^Note [0-9]+: [a-z ]*$'),
    ('mission_notes', 'body', lorem),
    ('artifacts', 'title', '^Artifact [0-9]+: [a-z ]*$'),
    ('artifacts', 'content', lorem),
    ('task_schedules', 'name', '^Schedule [0-9]+: [a-z ]*$'),
    ('workspace_skills', 'content', lorem),
    ('workspace_skills', 'description', lorem),
    ('memories', 'title', '^Memory [0-9]+: [a-z ]*$'),
    ('memories', 'content', lorem),
    ('experiments', 'title', '^Experiment [0-9]+: [a-z ]*$'),
    ('connectors', 'name', '^Connector [0-9]+$')
  ) AS v(t, c, p) LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I IS NOT NULL AND %I::text !~ $1)', r.t, r.c, r.c)
      INTO hit USING r.p;
    IF hit THEN bad := bad || (r.t || '.' || r.c); END IF;
  END LOOP;
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'scrub guard: non-placeholder values survive in %', array_to_string(bad, ', ');
  END IF;

  -- 2. Known identifiers anywhere ---------------------------------------------
  ids := btrim(coalesce(current_setting('qa.ids', true), ''));
  IF ids = '' THEN
    RAISE EXCEPTION 'scrub guard: NO_PROD_DATA_IDENTIFIERS is empty or unset';
  END IF;
  -- The secret is written for Python's re (see scripts/check_no_prod_data.py).
  -- Postgres AREs spell word boundaries \y / \Y; \b there is a backspace, which
  -- would silently match nothing.
  ids := replace(replace(ids, '\b', '\y'), '\B', '\Y');
  PERFORM 'probe' ~* ids;  -- an invalid pattern raises here
  IF '' ~* ids THEN
    RAISE EXCEPTION 'scrub guard: identifier pattern matches the empty string';
  END IF;

  FOR r IN
    SELECT c.table_name, array_agg(c.column_name::text ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND (c.data_type IN ('text', 'character varying', 'character', 'json', 'jsonb')
           OR (c.data_type = 'ARRAY' AND c.udt_name IN ('_text', '_varchar')))
    GROUP BY c.table_name
  LOOP
    SELECT string_agg(format('%I::text ~* $1', col), ' OR ') INTO cond FROM unnest(r.cols) AS col;
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %s)', r.table_name, cond) INTO hit USING ids;
    IF hit THEN
      FOR i IN 1 .. cardinality(r.cols) LOOP
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE %I::text ~* $1)', r.table_name, r.cols[i])
          INTO hit USING ids;
        IF hit THEN bad := bad || (r.table_name || '.' || r.cols[i]); END IF;
      END LOOP;
    END IF;
  END LOOP;
  IF cardinality(bad) > 0 THEN
    RAISE EXCEPTION 'scrub guard: identifying text survives in %', array_to_string(bad, ', ');
  END IF;

  RAISE NOTICE 'scrub guard: passed';
END
$guard$;

RESET qa.ids;
