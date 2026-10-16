-- Conflict and migration-collision attempts predating overlapPolicy v2 stored
-- only automatically inferred overlap edges, without inferredDependsOn tags.
-- Their shared dispatch path never copied caller-declared dependencies, and
-- AttemptIdentity contains only routing and phase fields. Unlike normal tasks,
-- every edge on these legacy attempts can therefore be reconciled safely.
--
-- Match 0267: retain prior declaration metadata/evidence, move edges to soft
-- evidence, and mark v2. The claim gate re-evaluates current scope and excludes
-- pending holders blocked by the attempt's subject PR; active migration work
-- still holds. Only pending conflict/collision attempts are eligible. A second
-- run does nothing. This UPDATE does not fire the status/start_at wake trigger;
-- the normal runner poll picks up the reconciled attempt, without duplicating it.
UPDATE "tasks" AS t
SET
  "depends_on" = '[]'::jsonb,
  "path_declaration" = (COALESCE(t."path_declaration", '{}'::jsonb) - 'inferredDependsOn')
    || jsonb_build_object(
      'overlapPolicy', 'v2',
      'softOverlaps', COALESCE(t."path_declaration" -> 'softOverlaps', '[]'::jsonb) || COALESCE((
        SELECT jsonb_agg(jsonb_build_object('taskId', d.value, 'paths', '[]'::jsonb, 'kind', 'legacy_inferred') ORDER BY d.ord)
        FROM jsonb_array_elements(t."depends_on") WITH ORDINALITY AS d(value, ord)
      ), '[]'::jsonb)
    )
WHERE t."status" = 'pending'
  AND t."task_class" = 'attempt'
  AND t."conflict_retry_pr_number" IS NOT NULL
  AND (t."path_declaration" ->> 'overlapPolicy') IS NULL
  AND jsonb_typeof(t."depends_on") = 'array'
  AND jsonb_array_length(t."depends_on") > 0;
