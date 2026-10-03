# Cron jobs

[`cron-manifest.json`](../cron-manifest.json) is the source of truth for cron
triggers, including schedules, HTTP methods and enabled state. An external
scheduler calls the routes with `Authorization: Bearer $CRON_SECRET`; cron
triggers are not declared in `vercel.json`. Schedules use the manifest's
`America/New_York` timezone. Use `bun run cron:plan` to preview reconciliation,
`bun run cron:sync` to apply it, and `bun run cron:check` to check scheduler drift.

## Orchestration readout

`GET /api/cron/orchestration-readout` runs daily at 11:00
(`0 11 * * *`), on the hour inside the existing schedules-tick wake window.
The route requires `CRON_SECRET` authentication. It evaluates workspaces whose
team has opted in to `orchestration_manifest` or `orchestration_claim` through
`enabledDecisionShadows`. With no opted-in team, the readout performs one
workspace/team query and returns HTTP 200 without loading evidence or writing
artifacts or notes.

The existing claim and manifest loaders feed the orchestration evaluator over
a trailing 30-day window, with the last 7 days reserved as the later window.
Each workspace's result is upserted under the artifact key
`conflict-aware-orchestration-readout`. The artifact is private, has no share
token, and contains only aggregate verdicts, group identities, counts, metrics
and reasons. Replay rows, confusion example identifiers, paths, task titles,
task content and promotion drafts are excluded.

A group with verdict `eligible_for_gated` receives an advisory note naming the
group, attached to the workspace's latest task and its mission when present.
The note identity is stable per workspace and group, so repeated runs do not
post duplicate advisories. The job never promotes a group or changes an applying
fraction: promotion requires a reviewed, committed `ORCHESTRATION_PROMOTIONS`
entry validated by `resolveApplyingFraction` in
[`packages/core/orchestration-promotion.ts`](../packages/core/orchestration-promotion.ts).

Verify route behavior and manifest coverage with isolated test processes:

```sh
bun run scripts/run-unit-tests.ts apps/web/src/app/api/cron/orchestration-readout/route.test.ts scripts/cron-coverage.test.ts
```
