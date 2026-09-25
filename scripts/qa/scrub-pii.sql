-- Scrub a prod clone before the Visual QA app boots (.github/workflows/visual-qa.yml).
--
-- Invariant: after this runs, no tenant-authored or identifying text survives in
-- any column a page can render. Screenshots of this clone go into a GitHub
-- artifact on a PUBLIC repo, so they show layout, never content.
--
-- Every text/varchar/json(b) column of every table in packages/core/db/schema.ts
-- is either rewritten here, wiped with its table, or listed as structurally safe
-- (ids, hashes, enums, timestamps) in scripts/qa/scrub-pii.test.ts. That test
-- fails when a new column is added without a decision.
--
-- Placeholders are deterministic (row number / md5 of the old value) and roughly
-- length-preserving so layout stays realistic. Ids, statuses, timestamps, counts
-- and enums are untouched so every state still renders.
--
-- Rules for editing (the coverage test parses this file):
--   * one `column = expression` per assignment, in UPDATE ... SET;
--   * no FROM/WHERE inside a SET expression; put logic in a pg_temp function;
--   * plain statements, no transaction block. Safe to run twice.
--
-- scripts/qa/scrub-guard.sql runs next and fails the job if anything slipped.
-- Never print row content from here.

\set ON_ERROR_STOP on
-- Command tags carry row counts, and CI logs on this repo are public.
\set QUIET on

-- Known identifiers (NO_PROD_DATA_IDENTIFIERS, via `psql -v ids=…`). Anything
-- matching is redacted wherever it survives the shape rules below: kept enum-
-- like tokens, jsonb object keys, tool names. An unset -v ids leaves `:'ids'`
-- literal, a syntax error (fail closed). Never SELECT this setting.
SET qa.ids = :'ids';

-- ---------------------------------------------------------------------------
-- Helpers (session-local; vanish when psql exits)
-- ---------------------------------------------------------------------------

-- The secret is written for Python's re; Postgres AREs spell word boundaries
-- \y / \Y (\b is a backspace there and would silently match nothing).
CREATE OR REPLACE FUNCTION pg_temp.qa_ids() RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT nullif(replace(replace(btrim(coalesce(current_setting('qa.ids', true), '')), '\b', '\y'), '\B', '\Y'), '')
$f$;

DO $check$
BEGIN
  IF pg_temp.qa_ids() IS NULL THEN
    RAISE EXCEPTION 'scrub: identifier pattern (-v ids) is empty';
  END IF;
  PERFORM 'probe' ~* pg_temp.qa_ids();  -- an invalid pattern raises here
END
$check$;

CREATE OR REPLACE FUNCTION pg_temp.qa_is_ident(s text) RETURNS boolean
LANGUAGE sql STABLE AS $f$
  SELECT s IS NOT NULL AND s ~* pg_temp.qa_ids()
$f$;

-- Same-length hex-ish token for a value that must not survive.
CREATE OR REPLACE FUNCTION pg_temp.qa_token(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL ELSE left('x' || md5(s) || md5(s || '.'), greatest(least(length(s), 64), 4)) END
$f$;

-- Lorem of length n, [a-z ] only. The guard's "lorem" pattern is ^[a-z ]*$.
CREATE OR REPLACE FUNCTION pg_temp.qa_lorem(n integer) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT rtrim(left(
    repeat('lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore ', 1 + greatest(coalesce(n, 0), 5) / 100),
    least(greatest(coalesce(n, 0), 5), 4000)))
$f$;

-- NULL-preserving lorem of the same length.
CREATE OR REPLACE FUNCTION pg_temp.qa_text(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL WHEN s = '' THEN '' ELSE pg_temp.qa_lorem(length(s)) END
$f$;

-- "<Prefix> <n>: <lorem>" keeping the old length.
CREATE OR REPLACE FUNCTION pg_temp.qa_title(prefix text, n bigint, s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL
    ELSE prefix || ' ' || n || ': ' || pg_temp.qa_lorem(length(s) - length(prefix) - 4) END
$f$;

-- Stable short token from a value (keeps grouping, drops meaning).
CREATE OR REPLACE FUNCTION pg_temp.qa_hash(prefix text, s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL ELSE prefix || left(md5(s), 8) END
$f$;

-- PR URL keeping only the PR number.
CREATE OR REPLACE FUNCTION pg_temp.qa_pr_url(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL
    WHEN s ~ '/pull/[0-9]+' THEN 'https://github.com/org-1/repo-1/pull/' || (regexp_match(s, '/pull/([0-9]+)'))[1]
    ELSE 'https://github.com/org-1/repo-1' END
$f$;

-- Generic URL placeholder (PR URLs keep their number).
CREATE OR REPLACE FUNCTION pg_temp.qa_url(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL
    WHEN s ~ '/pull/[0-9]+' THEN pg_temp.qa_pr_url(s)
    ELSE 'https://example.invalid/' || left(md5(s), 12) END
$f$;

-- Branch placeholder; the trunk names are not identifying and drive UI logic.
CREATE OR REPLACE FUNCTION pg_temp.qa_branch(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL
    WHEN s IN ('main', 'dev', 'master', 'develop', 'staging') THEN s
    ELSE 'buildd/' || left(md5(s), 8) END
$f$;

-- Role slugs: the seeded defaults are public; anything custom is hashed the
-- same way everywhere it appears so routing and delegation still line up.
CREATE OR REPLACE FUNCTION pg_temp.qa_slug(s text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN s IS NULL THEN NULL
    WHEN s IN ('organizer', 'builder', 'researcher', 'writer', 'ops', 'reviewer') THEN s
    ELSE 'role-' || left(md5(s), 6) END
$f$;

-- One string of unknown meaning (jsonb leaves, semi-structured columns).
-- Keeps what is structural (uuids, shas, timestamps, numbers, snake_case enum
-- tokens, model ids); everything else becomes a placeholder of similar length.
CREATE OR REPLACE FUNCTION pg_temp.qa_str(s text) RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT CASE
    WHEN s IS NULL THEN NULL
    WHEN s = '' THEN ''
    WHEN pg_temp.qa_is_ident(s) THEN
      CASE WHEN s ~ '\s' THEN pg_temp.qa_lorem(length(s)) ELSE pg_temp.qa_token(s) END
    WHEN s ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN s
    WHEN s ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9:]+)?)?$' THEN s
    WHEN s ~ '^[0-9a-f]{7,40}$' THEN s
    WHEN s ~ '^[-+]?[0-9]+(\.[0-9]+)?$' THEN s
    WHEN s ~ '^[a-z][a-z0-9_]{0,31}$' THEN s
    WHEN s ~ '^(claude|gpt|o[0-9])[a-z0-9.-]*$' THEN s
    WHEN s ~* '^https?://' THEN pg_temp.qa_url(s)
    WHEN s !~ '\s' THEN pg_temp.qa_token(s)
    ELSE pg_temp.qa_lorem(length(s))
  END
$f$;

-- Object keys stay (they are structure) unless they match a known identifier:
-- map-shaped columns key by server, connector or env-var name.
CREATE OR REPLACE FUNCTION pg_temp.qa_key(k text) RETURNS text
LANGUAGE sql STABLE AS $f$
  SELECT CASE WHEN pg_temp.qa_is_ident(k) THEN 'k' || left(md5(k), 8) ELSE k END
$f$;

-- Recursive jsonb scrub: numbers, booleans and shape kept; keys via qa_key,
-- strings via qa_str. redact_only = true replaces identifier matches only
-- (for lists whose other values are structural, e.g. tool names).
CREATE OR REPLACE FUNCTION pg_temp.qa_json(j jsonb, redact_only boolean DEFAULT false) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  out jsonb;
  s text;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      SELECT coalesce(jsonb_object_agg(pg_temp.qa_key(k), pg_temp.qa_json(v, redact_only)), '{}'::jsonb)
        INTO out FROM jsonb_each(j) AS e(k, v);
    WHEN 'array' THEN
      SELECT coalesce(jsonb_agg(pg_temp.qa_json(v, redact_only) ORDER BY i), '[]'::jsonb)
        INTO out FROM jsonb_array_elements(j) WITH ORDINALITY AS a(v, i);
    WHEN 'string' THEN
      s := j #>> '{}';
      IF redact_only THEN
        out := CASE WHEN pg_temp.qa_is_ident(s) THEN to_jsonb(pg_temp.qa_token(s)) ELSE j END;
      ELSE
        out := to_jsonb(pg_temp.qa_str(s));
      END IF;
    ELSE
      out := j;
  END CASE;
  RETURN out;
END
$f$;

CREATE OR REPLACE FUNCTION pg_temp.qa_slug_array(j jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN j IS NULL OR jsonb_typeof(j) <> 'array' THEN j
    ELSE (SELECT coalesce(jsonb_agg(to_jsonb(pg_temp.qa_slug(e)) ORDER BY i), '[]'::jsonb)
          FROM jsonb_array_elements_text(j) WITH ORDINALITY AS a(e, i)) END
$f$;

CREATE OR REPLACE FUNCTION pg_temp.qa_text_array(prefix text, a text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE WHEN a IS NULL THEN NULL
    ELSE coalesce((SELECT array_agg(prefix || left(md5(e), 8) ORDER BY i) FROM unnest(a) WITH ORDINALITY AS u(e, i)), '{}') END
$f$;

-- ---------------------------------------------------------------------------
-- Credentials and telemetry: wiped outright. Nothing here is needed to render
-- a page, and most of it is secret.
-- ---------------------------------------------------------------------------

DELETE FROM secrets;             -- cascades credential_leases
DELETE FROM device_codes;
DELETE FROM oauth_codes;
DELETE FROM oauth_refresh_tokens;
DELETE FROM oauth_clients;
DELETE FROM system_cache;
DELETE FROM cron_runs;
DELETE FROM gate_events;
DELETE FROM watcher_events;
DELETE FROM action_queue_snoozes;
DELETE FROM task_area_prediction_events;
DELETE FROM review_feedback;
DELETE FROM spec_discrepancies;
TRUNCATE knowledge_chunks, knowledge_entities, entity_aliases, chunk_entities,
  pending_entity_refs, knowledge_edges, knowledge_ingest_jobs;

-- ---------------------------------------------------------------------------
-- People and tenancy
-- ---------------------------------------------------------------------------

-- Designate one team owner as the CI QA user (DEV_USER_EMAIL). Must run first.
UPDATE users SET
  email = 'ci-qa@buildd.dev',
  name = 'CI QA User'
WHERE id = (
  SELECT u.id FROM users u JOIN team_members tm ON tm.user_id = u.id
  WHERE tm.role = 'owner' ORDER BY u.created_at, u.id LIMIT 1
) AND email <> 'ci-qa@buildd.dev'
  AND NOT EXISTS (SELECT 1 FROM users WHERE email = 'ci-qa@buildd.dev');

UPDATE users SET
  email = 'user-' || replace(id::text, '-', '') || '@scrubbed.local',
  name = 'User ' || left(id::text, 8),
  image = NULL,
  google_id = NULL,
  github_id = NULL
WHERE email <> 'ci-qa@buildd.dev';

UPDATE users SET
  image = NULL,
  google_id = NULL,
  github_id = NULL
WHERE email = 'ci-qa@buildd.dev';

UPDATE team_invitations SET
  email = 'invite-' || replace(id::text, '-', '') || '@scrubbed.local',
  token = 'scrubbed-' || md5(id::text);

UPDATE teams t SET
  name = 'Team ' || s.n,
  slug = 'team-' || s.n
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM teams) s WHERE t.id = s.id;

UPDATE accounts a SET
  name = 'Account ' || s.n,
  api_key = 'bld_scrubbed_' || replace(a.id::text, '-', ''),
  api_key_prefix = 'bld_scr',
  github_id = NULL,
  oauth_token = NULL,
  seat_id = NULL
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM accounts) s WHERE a.id = s.id;

UPDATE workspaces w SET
  name = 'Workspace ' || s.n,
  repo = CASE WHEN w.repo IS NULL THEN NULL ELSE 'https://github.com/org-' || s.n || '/repo-' || s.n END,
  local_path = CASE WHEN w.local_path IS NULL THEN NULL ELSE '/home/runner/workspace-' || s.n END,
  memory = pg_temp.qa_json(w.memory),
  projects = pg_temp.qa_json(w.projects),
  git_config = pg_temp.qa_json(w.git_config),
  webhook_config = NULL,
  release_config = pg_temp.qa_json(w.release_config),
  work_tracker_config = pg_temp.qa_json(w.work_tracker_config)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM workspaces) s WHERE w.id = s.id;

UPDATE github_installations g SET
  account_login = 'org-' || s.n,
  account_avatar_url = NULL,
  access_token = NULL
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM github_installations) s WHERE g.id = s.id;

UPDATE github_repos r SET
  full_name = 'org-' || s.n || '/repo-' || s.n,
  name = 'repo-' || s.n,
  owner = 'org-' || s.n,
  html_url = 'https://github.com/org-' || s.n || '/repo-' || s.n,
  description = pg_temp.qa_text(r.description)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM github_repos) s WHERE r.id = s.id;

UPDATE watched_projects SET
  repo = pg_temp.qa_hash('org-1/repo-', repo),
  vercel_project_id = pg_temp.qa_hash('prj_', vercel_project_id),
  release_pr_filter = pg_temp.qa_json(release_pr_filter),
  role_slug = pg_temp.qa_slug(role_slug),
  notes = pg_temp.qa_text(notes),
  last_error = pg_temp.qa_text(last_error);

UPDATE connectors c SET
  name = 'Connector ' || s.n,
  url = 'https://example.invalid/mcp/' || s.n,
  command = pg_temp.qa_str(c.command),
  args = '[]'::jsonb,
  env_mapping = pg_temp.qa_json(c.env_mapping),
  header_name = pg_temp.qa_str(c.header_name),
  discovered_metadata = pg_temp.qa_json(c.discovered_metadata),
  client_id = NULL,
  encrypted_client_secret = NULL,
  assertion_audience = pg_temp.qa_url(c.assertion_audience),
  assertion_token_endpoint = pg_temp.qa_url(c.assertion_token_endpoint)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM connectors) s WHERE c.id = s.id;

UPDATE worker_heartbeats SET
  local_ui_url = 'http://localhost:8766',
  viewer_token = CASE WHEN viewer_token IS NULL THEN NULL ELSE 'scrubbed-' || md5(id::text) END,
  environment = pg_temp.qa_json(environment);

-- ---------------------------------------------------------------------------
-- Work: missions, initiatives, tasks, workers
-- ---------------------------------------------------------------------------

UPDATE initiatives i SET
  title = pg_temp.qa_title('Initiative', s.n, i.title),
  description = pg_temp.qa_text(i.description),
  progress_cache = pg_temp.qa_json(i.progress_cache),
  kpis = pg_temp.qa_json(i.kpis),
  kpi_state = pg_temp.qa_json(i.kpi_state)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM initiatives) s WHERE i.id = s.id;

UPDATE missions m SET
  title = pg_temp.qa_title('Mission', s.n, m.title),
  description = pg_temp.qa_text(m.description),
  working_branch = CASE WHEN m.working_branch IS NULL THEN NULL ELSE 'buildd/' || left(md5(m.id::text), 8) || '-mission-' || s.n END,
  primary_pr_url = pg_temp.qa_pr_url(m.primary_pr_url),
  merge_policy = pg_temp.qa_json(m.merge_policy),
  external_issue_id = CASE WHEN m.external_issue_id IS NULL THEN NULL ELSE 'EXT-' || s.n END,
  external_issue_url = pg_temp.qa_url(m.external_issue_url),
  goal_criteria = pg_temp.qa_json(m.goal_criteria),
  goal_criteria_state = pg_temp.qa_json(m.goal_criteria_state),
  criteria_reviewer_findings = pg_temp.qa_json(m.criteria_reviewer_findings),
  flight_strip_cache = pg_temp.qa_json(m.flight_strip_cache)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM missions) s WHERE m.id = s.id;

UPDATE tasks t SET
  title = pg_temp.qa_title('Task', s.n, t.title),
  description = pg_temp.qa_text(t.description),
  context = pg_temp.qa_json(t.context),
  result = pg_temp.qa_json(t.result),
  release_result = pg_temp.qa_json(t.release_result),
  output_schema = pg_temp.qa_json(t.output_schema),
  path_manifest = pg_temp.qa_json(t.path_manifest),
  loop_config = pg_temp.qa_json(t.loop_config),
  subject_anchor = pg_temp.qa_json(t.subject_anchor),
  external_id = CASE WHEN t.external_id IS NULL THEN NULL ELSE 'EXT-' || s.n END,
  external_url = pg_temp.qa_url(t.external_url),
  external_issue_id = CASE WHEN t.external_issue_id IS NULL THEN NULL ELSE 'EXT-' || s.n END,
  external_issue_url = pg_temp.qa_url(t.external_issue_url),
  project = pg_temp.qa_hash('project-', t.project),
  mission_phase_label = pg_temp.qa_hash('Phase ', t.mission_phase_label),
  role_slug = pg_temp.qa_slug(t.role_slug),
  subject_branch = pg_temp.qa_branch(t.subject_branch),
  subject_error_signature = pg_temp.qa_hash('sig-', t.subject_error_signature)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM tasks) s WHERE t.id = s.id;

UPDATE task_subject_reports SET
  note = pg_temp.qa_text(note),
  anchor_snapshot = pg_temp.qa_json(anchor_snapshot);

-- mcp_calls / subagent_spans are bulky tool-call logs: emptied, not rewritten.
UPDATE workers w SET
  name = 'worker-' || left(md5(w.id::text), 8),
  runner = pg_temp.qa_hash('runner-', w.runner),
  branch = 'buildd/' || left(md5(w.id::text), 8) || '-task-' || s.n,
  waiting_for = pg_temp.qa_json(w.waiting_for),
  error = CASE WHEN w.error IS NULL THEN NULL ELSE 'Error: ' || pg_temp.qa_lorem(length(w.error) - 7) END,
  local_ui_url = CASE WHEN w.local_ui_url IS NULL THEN NULL ELSE 'http://localhost:8766' END,
  current_action = pg_temp.qa_text(w.current_action),
  milestones = pg_temp.qa_json(w.milestones),
  pr_url = pg_temp.qa_pr_url(w.pr_url),
  pr_unresolvable_reason = pg_temp.qa_text(w.pr_unresolvable_reason),
  pr_base_ref = pg_temp.qa_branch(w.pr_base_ref),
  superseded_by_pr_url = pg_temp.qa_pr_url(w.superseded_by_pr_url),
  superseded_reason = pg_temp.qa_text(w.superseded_reason),
  superseded_recorded_by = pg_temp.qa_str(w.superseded_recorded_by),
  pending_instructions = pg_temp.qa_text(w.pending_instructions),
  instruction_history = pg_temp.qa_json(w.instruction_history),
  result_meta = pg_temp.qa_json(w.result_meta),
  rejected_completion_payload = pg_temp.qa_json(w.rejected_completion_payload),
  verification_evidence = pg_temp.qa_json(w.verification_evidence),
  mcp_calls = '[]'::jsonb,
  subagent_spans = '[]'::jsonb,
  degraded_connectors = pg_temp.qa_json(w.degraded_connectors),
  observed_touches = pg_temp.qa_json(w.observed_touches),
  post_supersession_error = pg_temp.qa_text(w.post_supersession_error)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM workers) s WHERE w.id = s.id;

UPDATE worker_error_traces SET
  pattern = pg_temp.qa_str(pattern),
  excerpt = pg_temp.qa_text(excerpt),
  source = pg_temp.qa_str(source);

UPDATE worker_terminal_records SET
  detail = pg_temp.qa_json(detail);

UPDATE worker_prompt_composition_events SET
  task_match_derived_by = pg_temp.qa_str(task_match_derived_by);

-- ---------------------------------------------------------------------------
-- Notes, artifacts, schedules, roles, memory
-- ---------------------------------------------------------------------------

UPDATE mission_notes n SET
  title = pg_temp.qa_title('Note', s.n, n.title),
  body = pg_temp.qa_text(n.body),
  actor_label = pg_temp.qa_hash('Actor ', n.actor_label),
  collapse_key = pg_temp.qa_hash('key-', n.collapse_key),
  default_choice = pg_temp.qa_text(n.default_choice)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM mission_notes) s WHERE n.id = s.id;

UPDATE artifacts a SET
  key = pg_temp.qa_hash('artifact-', a.key),
  title = pg_temp.qa_title('Artifact', s.n, a.title),
  content = pg_temp.qa_text(a.content),
  storage_key = CASE WHEN a.storage_key IS NULL THEN NULL ELSE 'artifacts/' || a.id END,
  share_token = CASE WHEN a.share_token IS NULL THEN NULL ELSE 'scrubbed-' || md5(a.id::text) END,
  metadata = pg_temp.qa_json(a.metadata)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM artifacts) s WHERE a.id = s.id;

UPDATE task_schedules ts SET
  name = pg_temp.qa_title('Schedule', s.n, ts.name),
  task_template = pg_temp.qa_json(ts.task_template),
  last_error = pg_temp.qa_text(ts.last_error),
  last_trigger_value = pg_temp.qa_str(ts.last_trigger_value),
  pending_suggestion = pg_temp.qa_json(ts.pending_suggestion)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM task_schedules) s WHERE ts.id = s.id;

UPDATE workspace_skills k SET
  name = CASE WHEN pg_temp.qa_slug(k.slug) = k.slug THEN initcap(k.slug) ELSE 'Skill ' || s.n END,
  slug = pg_temp.qa_slug(k.slug),
  description = pg_temp.qa_text(k.description),
  content = pg_temp.qa_text(k.content),
  source = pg_temp.qa_str(k.source),
  metadata = pg_temp.qa_json(k.metadata),
  allowed_tools = pg_temp.qa_json(k.allowed_tools, true),
  can_delegate_to = pg_temp.qa_slug_array(k.can_delegate_to),
  mcp_servers = pg_temp.qa_json(k.mcp_servers),
  required_env_vars = pg_temp.qa_json(k.required_env_vars),
  connector_refs = pg_temp.qa_json(k.connector_refs),
  repo_url = pg_temp.qa_url(k.repo_url)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM workspace_skills) s WHERE k.id = s.id;

UPDATE memories m SET
  title = pg_temp.qa_title('Memory', s.n, m.title),
  content = pg_temp.qa_text(m.content),
  project = pg_temp.qa_hash('project-', m.project),
  tags = pg_temp.qa_text_array('tag-', m.tags),
  files = pg_temp.qa_text_array('path/', m.files),
  source = pg_temp.qa_str(m.source)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM memories) s WHERE m.id = s.id;

UPDATE experiments e SET
  key = pg_temp.qa_hash('exp-', e.key),
  title = pg_temp.qa_title('Experiment', s.n, e.title),
  hypothesis = pg_temp.qa_text(e.hypothesis),
  config = pg_temp.qa_json(e.config),
  decision = pg_temp.qa_text(e.decision)
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM experiments) s WHERE e.id = s.id;

UPDATE experiment_assignments SET
  eligibility = pg_temp.qa_json(eligibility);

UPDATE user_feedback SET
  comment = pg_temp.qa_text(comment);

-- ---------------------------------------------------------------------------
-- Delivery plumbing: releases, claims, links, logs
-- ---------------------------------------------------------------------------

UPDATE releases SET
  unit = pg_temp.qa_str(unit),
  run_url = pg_temp.qa_url(run_url),
  deploy_url = pg_temp.qa_url(deploy_url),
  failure_reason = pg_temp.qa_text(failure_reason);

UPDATE external_links SET
  external_id = pg_temp.qa_hash('EXT-', external_id),
  external_url = pg_temp.qa_url(external_url);

UPDATE change_intents SET
  surface = pg_temp.qa_hash('path/', surface),
  branch = pg_temp.qa_branch(branch);

UPDATE path_claims SET
  path = pg_temp.qa_hash('path/', path);

UPDATE path_claim_waiters SET
  blocked_path = pg_temp.qa_hash('path/', blocked_path);

UPDATE backend_pauses SET
  reason = pg_temp.qa_str(reason);

UPDATE migration_log SET
  error = pg_temp.qa_text(error),
  detail = pg_temp.qa_json(detail);

RESET qa.ids;
