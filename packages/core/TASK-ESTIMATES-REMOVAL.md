# Removing the task estimates experiment

Task estimates write one frozen p50/p80 estimate (minutes, tokens, expected
repairs) per new work task on an opted-in team, into its own `task_estimates`
table, and show it in `get_task` with `include: ["scheduling"]`. This is
everything it adds. Nothing else reads it.

## To turn it off without removing code

- One team: `PATCH /api/teams/<teamId>` with `{ "taskEstimates": { "enabled": false } }`
  (owner/admin session). New tasks stop getting a row; existing rows stay and
  still show in `get_task`. Delete them by hand if wanted:
  `DELETE FROM task_estimates WHERE team_id = '<teamId>'`.
- Everyone: set `teams.task_estimates` to NULL for every team. NULL is off.

## Files (delete them)

- `packages/core/task-estimate.ts` (the pure blend) and
  `packages/core/__tests__/task-estimate.test.ts`
- `packages/core/task-estimate-source.ts` (prior, inputs, write, read) and
  `packages/core/__tests__/task-estimate-source.test.ts`
- `apps/web/src/lib/task-estimate-hook.ts` (the post-insert hook) and its test
- This file

## Touch points (edit them)

- `packages/core/package.json`: the `./task-estimate` and
  `./task-estimate-source` exports.
- `packages/core/task-size-estimate.ts`: `defaultStore` is exported only for
  the estimate source; it can go back to module-private.
- The hook calls, one `scheduleTaskEstimate(...)` block each:
  `apps/web/src/app/api/tasks/route.ts` (POST; MCP `create_task` and chat land
  here), `apps/web/src/lib/approve-plan.ts`, and
  `apps/web/src/app/api/cron/schedules/route.ts`. In
  `apps/web/src/app/api/tasks/route.test.ts`, the
  `@buildd/core/task-estimate-source` mock and the "task estimate (experiment)"
  describe block.
- `get_task`:
  - `apps/web/src/app/api/tasks/[id]/route.ts`: the `include=estimate` block
    (and the `readTaskEstimate` mock + test in `route.test.ts`).
  - `packages/core/mcp-tools.ts`: `formatTaskEstimateLine`, its call at the end
    of `formatTaskScheduling`, and the `scheduling` → `estimate` mapping of
    `serverIncludes` in `get_task` (go back to filtering `scheduling` out). In
    `packages/core/__tests__/mcp-tools-get-task.test.ts`, the two estimate tests
    and the `?include=estimate` URL assertion (back to the bare URL).
- `apps/web/src/app/api/teams/[id]/route.ts`: the `taskEstimates` PATCH field
  and the `taskEstimates: true` GET column (and the "task estimates experiment
  switch" tests in `route.test.ts`).
- `scripts/qa/scrub-pii.sql`: `DELETE FROM task_estimates;`, and
  `scripts/qa/scrub-pii.test.ts`: `task_estimates` in the `teams` entry of
  `SAFE` (remove in the same release as the schema).
- Config, if set: the `system_cache` row `task_estimate_config` and the
  `BUILDD_TASK_ESTIMATE_K0` env var.
- `packages/core/db/schema.ts`: the `taskEstimates` table,
  `TaskEstimateExplanation`, `TaskEstimate`/`NewTaskEstimate`, and the
  `teams.taskEstimates` column.

## The schema, in two releases

Follow `.claude/skills/schema-change/SKILL.md`. `db:migrate` runs before the
new build serves, so the old build is still reading these for the length of
the deploy:

1. Release 1: delete the files and touch points above, except `schema.ts` and
   the scrub-pii entries.
2. Release 2: delete the table and column from `schema.ts` (and the scrub-pii
   entries), run `cd packages/core && bun db:generate`, and check the
   generated SQL is only:

```sql
DROP TABLE IF EXISTS "task_estimates" CASCADE;
ALTER TABLE "teams" DROP COLUMN IF EXISTS "task_estimates";
```

## What stays behind, on purpose

Nothing. The estimate never changes a task row, a claim, a route or a
schedule, so dropping the table reverts the experiment completely.
