-- Legacy inferred path-overlap edges become soft scheduling evidence.
--
-- Before the hard/soft overlap split, POST /api/tasks stored EVERY concrete
-- manifest overlap with an in-flight task as a dependsOn edge, including
-- directory-prefix-only overlap, and recorded those ids in
-- path_declaration.inferredDependsOn. A stored edge blocks until the upstream
-- task completes AND its PR merges, and nothing re-checks it, so a task that
-- declared a broad directory queued behind every task under it.
--
-- For still-pending tasks, move the inferred ids out of depends_on into
-- path_declaration.softOverlaps (kind legacy_inferred). The claim route
-- reclassifies each one against the CURRENT manifests: a same-file or
-- migration overlap still holds deterministically while the other task is in
-- flight; a prefix-only overlap goes to the HOLD/START decision; an overlap
-- that no longer exists releases.
--
-- Caller-supplied edges are never in inferredDependsOn and are untouched.
-- Idempotent: converted rows carry overlapPolicy = 'v2' and are skipped on a
-- re-run. Only pending rows: a started or finished task's edges no longer gate
-- anything. The dispatch trigger fires on status/start_at only, so this
-- update wakes nothing by itself; the next claim poll sees the freed tasks.
UPDATE "tasks" AS t
SET
  "depends_on" = COALESCE((
    SELECT jsonb_agg(d.value ORDER BY d.ord)
    FROM jsonb_array_elements(COALESCE(t."depends_on", '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
    WHERE NOT ((t."path_declaration" -> 'inferredDependsOn') @> jsonb_build_array(d.value))
  ), '[]'::jsonb),
  "path_declaration" = (t."path_declaration" - 'inferredDependsOn')
    || jsonb_build_object(
      'overlapPolicy', 'v2',
      'softOverlaps', COALESCE(t."path_declaration" -> 'softOverlaps', '[]'::jsonb) || COALESCE((
        SELECT jsonb_agg(jsonb_build_object('taskId', i.value, 'paths', '[]'::jsonb, 'kind', 'legacy_inferred'))
        FROM jsonb_array_elements(t."path_declaration" -> 'inferredDependsOn') AS i(value)
      ), '[]'::jsonb)
    )
WHERE t."status" = 'pending'
  AND jsonb_typeof(t."path_declaration" -> 'inferredDependsOn') = 'array'
  AND jsonb_array_length(t."path_declaration" -> 'inferredDependsOn') > 0
  AND (t."path_declaration" ->> 'overlapPolicy') IS NULL;
