-- Adversarial presence seed for verification task b0de88fa (verification
-- branch only; runs on the scrubbed CI clone after the guard, never on prod).
--
-- The scrub deletes every local_sessions row, so a scrubbed clone cannot show
-- a ghost session. This inserts four sessions into the busiest workspace of
-- the busiest team, with placeholder text only:
--   ghost  : client last heard 3h ago, never ended, holds a RUNNING worker
--            whose updated_at was bumped just now (the Oct 9 shape), five
--            finished claims and one task claimed twice.
--   live   : client heard just now, holds a running worker.
--   ended  : client ended 30m ago, its worker still reads running.
--   online : client heard just now, no claims.
-- Prints the team id and its busiest mission (one line) so the workflow can
-- render as that team and resolve /app/missions/:id. Neither is logged.

\set ON_ERROR_STOP 1

CREATE TEMP TABLE qa_out (team_id uuid, mission_id uuid);

DO $$
DECLARE
  ws uuid; team uuid; ci uuid;
  s_ghost uuid := gen_random_uuid(); s_live uuid := gen_random_uuid();
  s_ended uuid := gen_random_uuid(); s_online uuid := gen_random_uuid();
  t uuid; w uuid; i int;
BEGIN
  SELECT w2.id, w2.team_id INTO ws, team
  FROM workspaces w2
  JOIN tasks t2 ON t2.workspace_id = w2.id AND t2.created_at > now() - interval '7 days'
  GROUP BY w2.id, w2.team_id ORDER BY count(*) DESC LIMIT 1;
  SELECT id INTO ci FROM users WHERE email = 'ci-qa@buildd.dev';
  IF ws IS NULL OR ci IS NULL THEN RAISE EXCEPTION 'seed: no workspace or CI user'; END IF;

  INSERT INTO team_members (team_id, user_id, role) VALUES (team, ci, 'owner')
  ON CONFLICT DO NOTHING;
  -- The team's mission with the most task activity in the last 12h (real data).
  INSERT INTO qa_out
  SELECT team, (SELECT t3.mission_id FROM tasks t3 JOIN workspaces w3 ON w3.id = t3.workspace_id
                WHERE w3.team_id = team AND t3.mission_id IS NOT NULL AND t3.updated_at > now() - interval '12 hours'
                GROUP BY t3.mission_id ORDER BY count(*) DESC LIMIT 1);

  INSERT INTO local_sessions (id, user_id, workspace_id, client_kind, client_session_hash, repo, interactive, started_at, last_seen_at, ended_at, end_reason) VALUES
    (s_ghost,  ci, ws, 'claude', md5('qa-ghost'),  'org-qa/repo-qa', true, now() - interval '5 hours',   now() - interval '3 hours',  NULL, NULL),
    (s_live,   ci, ws, 'claude', md5('qa-live'),   'org-qa/repo-qa', true, now() - interval '40 minutes', now(),                      NULL, NULL),
    (s_ended,  ci, ws, 'claude', md5('qa-ended'),  'org-qa/repo-qa', true, now() - interval '2 hours',   now() - interval '30 minutes', now() - interval '30 minutes', 'exit'),
    (s_online, ci, ws, 'codex',  md5('qa-online'), 'org-qa/repo-qa', true, now() - interval '10 minutes', now(),                      NULL, NULL);

  -- Ghost: one running claim, its worker row bumped NOW by "the server".
  INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
    VALUES (ws, 'QA ghost: task held by a session whose client is gone', 'in_progress', now() - interval '4 hours', now()) RETURNING id INTO t;
  INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, created_at, updated_at)
    VALUES (ws, t, 'qa-ghost', 'mcp', 'buildd/qa-ghost', 'running', now() - interval '4 hours', now() - interval '4 hours', now()) RETURNING id INTO w;
  INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_ghost, now() - interval '4 hours');

  -- Ghost: one task claimed twice (first released, second still running).
  INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
    VALUES (ws, 'QA ghost: task claimed twice by the same session', 'in_progress', now() - interval '4 hours', now()) RETURNING id INTO t;
  INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, completed_at, created_at, updated_at)
    VALUES (ws, t, 'qa-twice-old', 'mcp', 'buildd/qa-twice', 'failed', now() - interval '4 hours', now() - interval '3 hours 30 minutes', now() - interval '4 hours', now() - interval '3 hours 30 minutes') RETURNING id INTO w;
  INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_ghost, now() - interval '4 hours');
  INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, created_at, updated_at)
    VALUES (ws, t, 'qa-twice-new', 'mcp', 'buildd/qa-twice', 'running', now() - interval '3 hours 20 minutes', now() - interval '3 hours 20 minutes', now() - interval '1 minute') RETURNING id INTO w;
  INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_ghost, now() - interval '3 hours 20 minutes');

  -- Ghost: five finished claims (exercises the "+N" collapse).
  FOR i IN 1..5 LOOP
    INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
      VALUES (ws, 'QA ghost: finished claim ' || i, 'completed', now() - interval '5 hours', now() - interval '3 hours') RETURNING id INTO t;
    INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, completed_at, created_at, updated_at)
      VALUES (ws, t, 'qa-done-' || i, 'mcp', 'buildd/qa-done-' || i, 'completed', now() - interval '5 hours', now() - interval '3 hours', now() - interval '5 hours', now() - interval '3 hours') RETURNING id INTO w;
    INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_ghost, now() - interval '5 hours' + (i || ' minutes')::interval);
  END LOOP;

  -- Live: client heard now, one running claim.
  INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
    VALUES (ws, 'QA live: task held by a session whose client is here', 'in_progress', now() - interval '30 minutes', now()) RETURNING id INTO t;
  INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, created_at, updated_at)
    VALUES (ws, t, 'qa-live', 'mcp', 'buildd/qa-live', 'running', now() - interval '30 minutes', now() - interval '30 minutes', now()) RETURNING id INTO w;
  INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_live, now() - interval '30 minutes');

  -- Ended: client said goodbye, worker row still says running.
  INSERT INTO tasks (workspace_id, title, status, created_at, updated_at)
    VALUES (ws, 'QA ended: task held by an ended session', 'in_progress', now() - interval '2 hours', now()) RETURNING id INTO t;
  INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, started_at, created_at, updated_at)
    VALUES (ws, t, 'qa-ended', 'mcp', 'buildd/qa-ended', 'running', now() - interval '2 hours', now() - interval '2 hours', now()) RETURNING id INTO w;
  INSERT INTO local_session_workers (worker_id, local_session_id, bound_at) VALUES (w, s_ended, now() - interval '2 hours');
END $$;

SELECT team_id || ' ' || coalesce(mission_id::text, '') FROM qa_out;
