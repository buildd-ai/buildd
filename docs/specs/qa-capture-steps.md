---
title: QA Capture Interaction Steps
status: active
owner: builder
last_verified: 2026-10-05
summary: Visual QA capture MUST be able to open a modal, menu or gated state through a validated, closed list of steps before a shot, and MUST NOT commit a write on a page backed by real data.
domain: surfaces
surfaces: [scripts/qa/steps.ts, scripts/qa/capture.ts, apps/web/src/lib/visual-audit-evidence.ts, scripts/demo/run-storyboard.ts]
keywords: [QA_PLAN, capture plan, stepFailed, commit step, visual audit, unsure, force-start dialog, storyboard, interaction steps, metadata.qa.state]
verified_by: [scripts/qa/steps.test.ts, apps/web/src/lib/visual-audit-evidence.test.ts]
assertions:
  - id: plan-validation
    type: symbol
    name: validatePlan
    path: scripts/qa/steps.ts
  - id: write-guard-methods
    type: symbol
    name: isMutatingMethod
    path: scripts/qa/steps.ts
  - id: capture-reads-qa-plan
    type: symbol_reachable
    symbol: QA_PLAN
    entry: scripts/qa/capture.ts
    as: read
  - id: storyboard-shares-step-engine
    type: symbol_reachable
    symbol: runSteps
    entry: scripts/demo/run-storyboard.ts
    as: import
supersedes: []
---

# QA Capture Interaction Steps

## Why

`scripts/qa/capture.ts` used to load a page and shoot it, and nothing else. Any modal,
menu, confirm or gated sub-state therefore came back `unsure` ("needs a live click this
capture can't perform"), and landed in the human review queue with nothing anyone could
act on. A plan of steps lets the auditor produce that state and look at it.

## Capture plan

**Capability statement**: Given `QA_PLAN`, capture MUST shoot every plan route at its base
state and then once per named state, on a fresh page load per state.

- `QA_PLAN` is a path to a JSON file, or the JSON itself when the value starts with `[`
  (so a workflow dispatch can pass it inline). Its shape:

  ```json
  [{ "route": "/app/tasks/<id>",
     "states": [{ "key": "force-start-dialog",
                  "steps": [{ "action": "click", "selector": "role:button[name=Start Task]", "commit": true },
                            { "action": "waitFor", "selector": "text:Force start" }] }] }]
  ```

- `QA_ROUTES` keeps working unchanged. Setting both `QA_ROUTES` and `QA_PLAN` is an error.
- A state `key` is lower-case `[a-z0-9-]`, unique within its route. The shot's id is the
  route's id plus `--<key>`; the base shot's id is unchanged.
- Each state starts from a fresh `goto` of the route, so steps never stack. A state shot is
  the viewport (the place a dialog or menu renders), not the unclipped full page.

## Action vocabulary

A closed list; any other `action` is rejected when the plan is validated:

| action | needs | does |
|---|---|---|
| `click` | `selector` | clicks the first match |
| `hover` | `selector` | hovers the first match |
| `fill` | `selector`, `value` | fills a field (typing never submits) |
| `press` | `key`, optional `selector` | presses a key (on the element, else the page) |
| `select` | `selector`, `value` | picks an option of a `<select>` |
| `waitFor` | `selector`, optional `state: visible \| hidden` | waits for it to appear (default) or go |
| `waitMs` | `ms` | sleeps, capped at 5000 ms |
| `assertLayout` | optional `selector` (scope, default `<body>`), optional `minTarget` (px, default 44) | checks the page: fails on horizontal overflow, and below `md` (768px) on any tap target smaller than `minTarget` in either direction |

Selectors: `testid:<id>`, `role:<role>[name=<accessible name>]`, `text:<text>`, `css:<css>`,
or raw CSS / a Playwright selector as a last resort. A bare word (`mission-detail`) is a
`data-testid`, which is the storyboard's existing rule. A step's `timeoutMs` defaults to
10 000 and is capped at 30 000.

The storyboard runner (`scripts/demo/run-storyboard.ts`) resolves selectors and runs its
`click` list through the same engine (`scripts/qa/steps.ts`), so the two cannot drift.

## Safety rule

**Capability statement**: A plan step MUST NOT commit a write unless it says so, and a
committing step MUST NOT run against a preview.

- A step may open, reveal and type. A step that sends a write (a confirm, a submit, a
  Start that POSTs) MUST carry `commit: true`.
- `commit: true` is honoured only when `QA_PAGE_SOURCE=sandbox`. Under `vercel-preview` the
  pages hit real data, so a plan holding any committing step is rejected before the browser
  launches, and the error names the step (`route`, state `key`, step index and selector).
- Enforced in the browser too: while a state's steps run and its shot is taken, every
  non-`GET`/`HEAD`/`OPTIONS` request is aborted, except during a `commit: true` step on the
  sandbox. Each aborted request is recorded as `blockedWrites` on the capture.
- Opening the task page's Force-start dialog takes a Start request, so that step is a
  commit step and sandbox-only; the CI sandbox runs with `DISABLE_WRITES=true`, so even that
  request cannot start the task.

## Failure behaviour

- A step whose selector is not found, or does not settle within its timeout, stops that
  state's steps. The shot is still taken at the point of failure, and the capture records
  `stepFailed: { index, selector, error }`. A failed step never crashes the run, and on its
  own never makes the exit code non-zero.
- An invalid plan (unknown action, missing field, duplicate key, bad JSON) exits 1 before
  the browser launches.
- `assertLayout` is the one step whose failure is a finding, not a step that did not settle.
  Its capture records `stepFailed` with `assertion: true` and every violation on one line
  (`layout: horizontal overflow: …; tap target button "…" is 30x30, under 44px`). Every shot
  is still written; then the run exits 4, so a dispatch with a layout-gated plan comes back red.
  Links inside running text (`display: inline`) are exempt from the tap-target rule.

## Evidence

- A state shot is uploaded with `metadata.qa.state = "<key>"`. Shots are keyed
  `route @ viewport @ state`.
- Required coverage stays route × viewport, plus route × theme (light and dark, at either
  viewport), at the base state: a state shot never satisfies a required cell and never
  makes one missing. Every other rule (non-empty finding, upload,
  an `issue` links a `[surface fix]` task) applies to state shots as to base ones.
- The review UI shows the state next to the route (`/app/tasks/:id · force-start-dialog`),
  and a state shot is its own cell, never replacing the base shot.

## Acceptance criteria

- AC-1: GIVEN `QA_PLAN` with one route and one state WHEN capture runs THEN `captures.json`
  holds a base entry with the unchanged id and a `<id>--<key>` entry with `state: "<key>"`.
- AC-2: GIVEN `QA_PAGE_SOURCE=vercel-preview` and a plan with a `commit: true` step WHEN the
  plan is validated THEN it is rejected with an error naming the route, state and step index.
- AC-3: GIVEN `QA_PAGE_SOURCE=sandbox` and the same plan WHEN the plan is validated THEN it
  is accepted.
- AC-4: GIVEN a step with an unknown `action` WHEN the plan is validated THEN it is rejected.
- AC-5: GIVEN a step whose selector matches nothing WHEN the state is captured THEN a shot
  is written, the entry carries `stepFailed` with that step's index and selector, and the
  process exits 0.
- AC-6: GIVEN a shot with `qa.state` set WHEN completion evidence is evaluated THEN it does
  not cover the route's required cell, and its absence does not make any cell missing.
- AC-7: GIVEN `metadata.qa.state` WHEN the shot is parsed THEN `state` round-trips.
- AC-8: GIVEN a run with only `QA_ROUTES` WHEN capture runs THEN `captures.json` has the same
  structure as before (no new required field).
- AC-9: GIVEN an `assertLayout` step on a 360px page that scrolls sideways or holds a 30x30
  button WHEN the state is captured THEN `stepFailed.assertion` is true, the error names each
  violation, and the process exits 4 after writing every shot.
- AC-10: GIVEN the same step at 1280px WHEN a target is under 44px THEN it passes (the
  tap-target rule applies below `md` only); overflow still fails at any width.

## Code surface

- `scripts/qa/steps.ts`: `parsePlan`, `validatePlan`, `runSteps`, `toLocator`,
  `isMutatingMethod`, `layoutViolations`.
- `scripts/qa/plans/run-activity.json`: the run-detail regression plan over
  `/app/dev/fixtures?state=run-activity&scenario=…`, one `layout` state per scenario.
- `scripts/qa/capture.ts`: `QA_PLAN` mode, the write guard, `stepFailed`.
- `scripts/demo/run-storyboard.ts`: selector resolution and clicks through the engine.
- `apps/web/src/lib/visual-audit-evidence.ts`: `parseQaMeta` reads `state`;
  `evaluateVisualAuditEvidence` counts only base shots toward coverage.
- `apps/web/src/lib/mission-visual-review.ts`: `state` in the caption and the cell.
- `.github/workflows/visual-qa.yml`: the `plan` dispatch input → `QA_PLAN`.

## Out of scope

- Stubbing network responses to fake a server state. A state the data can't produce (a real
  provider failure) stays `unsure`, with a `[surface fix]` task asking for a `?state=` fixture.
  Existing fixtures: `/app/settings/team?state=multi-member` (dev server only) adds a synthetic
  second member so Remove and the role select are reachable; it never writes.
  `/app/dev/fixtures?state=team-members&viewer=owner|admin|member` renders the team detail
  page (`/app/teams/[id]`) with an owner, an admin and a member, seen as each: role selects,
  Remove, Transfer ownership, the last-owner Leave gate and admin-vs-member gating. No DB; it
  never writes.
  `/app/health/insights?state=sample|empty|not-admin` covers the chart (platform owner only:
  anyone else gets a 404, so capture it signed in as an operator).
  `/app/health/runners?state=sample` draws the slots-busy chart from a synthetic fleet (every
  window), without worker rows.
  `/app/health/insights/tasks?state=sample|large` (optionally `&band=<key>`) renders a
  synthetic band drill-down, typical or holding hundreds of rows, without band params or DB rows.
- Video or multi-frame capture of a state (the storyboard's `record` / `type` stay its own).
