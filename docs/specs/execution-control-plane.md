---
title: Execution Control Plane
status: draft
owner: max
last_verified: 2026-10-11
summary: Authorized execution (claims, heartbeats, results, webhooks, Dispatch callbacks) MUST keep moving while the web app is down, served by a separate Worker running the same handlers.
domain: tasks
surfaces: [apps/control-plane/src/index.ts, apps/control-plane/src/router.ts, apps/control-plane/src/next-server-shim.ts, apps/control-plane/wrangler.jsonc]
related: [workflow-state-kernel, task-dispatch-authority, artifacts-and-sharing]
keywords: [control plane, extraction, cloudflare worker, web outage, execution path, ownership boundary, living specs, kernel, dispatch, cutover]
verified_by: [packages/core/__tests__/state-ownership.test.ts, apps/control-plane/src/index.test.ts, apps/web/src/app/api/deploy-identity/route.test.ts, apps/web/src/lib/release-health-watcher.test.ts]
supersedes: []
assertions:
  - id: control-plane-worker
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: symbol
    name: default
    path: apps/control-plane/src/index.ts
  - id: control-plane-test
    skip_until: "2026-12-15"
    skip_reason: "Spec is still draft; this assertion proves only that the named surface exists, not the spec's prose invariants. Remove when the spec is promoted to active."
    type: test_file
    path: apps/control-plane/src/index.test.ts
---
# Execution Control Plane

Owner decision, 2026-10-10: Buildd is four systems with one owner per state
machine. This supersedes the earlier "one control plane inside Next.js" default
(knowledge-base decision record on mission e1213404).

| System | Owns | Never |
|---|---|---|
| Living Specs (apps/web, Vercel) | spec revisions, approvals, normative references, artifacts and their links | advances execution state |
| Execution control plane (apps/control-plane, Cloudflare) | claims, leases, scheduling, delivery and PR lifecycle, verification records | writes Living Specs tables; authorizes a spec revision |
| Dispatch (apps/dispatch) | durable delivery, timers, retries, receipts | makes a scheduling decision (task-dispatch-authority.md) |
| Runners (apps/runner, apps/cloud-runner) | execution | declares an outcome verified |

## 1. Same handlers, second host

**Capability statement**: The execution path MUST be served by the same route
handlers on both hosts, so the control plane is a deployment boundary, not a
rewrite, and the two cannot drift.

**Invariants**:
- The Worker imports apps/web's own handlers for `POST /api/workers/claim`,
  `GET|PATCH /api/workers/[id]`, `POST /api/github/webhook`, and
  `POST /api/dispatch/v1/resolve|receipts|relay` (the three Dispatch callbacks). No other route is served.
- `next/server` resolves to a shim: `NextRequest` (Request plus `nextUrl`),
  `NextResponse` (`json`, `redirect`), `after()` (the request's
  `ctx.waitUntil`, and a throw outside a request, as in Next).
- The main module (`index.ts`) exports only `default`: workerd treats every
  named export as an entrypoint and refuses to start on one that is not a
  handler, so routing and health helpers live in `router.ts` (`index.test.ts`).
- `GITHUB_API_ORIGIN`, honoured only when it is a loopback `http:` origin,
  sends `https://api.github.com/*` to a local fake for the e2e; any other
  value is ignored, so it cannot redirect production GitHub calls
  (`index.test.ts`).
- `server-only`, `dotenv` and `@ast-grep/napi` resolve to stubs. The native
  `@ast-grep/napi` consumer already falls back when its binary cannot load.
- Config comes from `process.env` (`nodejs_compat_populate_process_env`); the
  database driver is the same neon-http driver as on Vercel.

**Acceptance criteria**:
- AC-1: GIVEN apps/web is not running WHEN a runner claims, heartbeats and
  completes a task against the control plane THEN the task and worker end
  `completed`; WHEN a signed `pull_request.closed` webhook for a merged,
  kernel-owned PR arrives THEN the delivery reaches `MERGED` and its
  post-merge effects run in the Worker; WHEN Dispatch sends a signed resolve
  and then a `delivered` receipt for a published wake THEN the resolve answers
  `deliver` and the outbox row ends `delivered`
  (`apps/control-plane/scripts/web-down-e2e.sh`, GitHub played by the kernel
  DB tests' stateful fake through `GITHUB_API_ORIGIN`; run 2026-10-11 under
  wrangler dev against migrated Postgres: PASS).
- AC-2: the router serves exactly these seven routes (`index.test.ts`).

## 2. Cutover and lockstep

**Capability statement**: The Worker MUST run exactly the commit production web
runs, so the execution handlers never differ between the two hosts.

**Invariants**:
- The Worker owns `buildd.dev/api/workers/*`, `/api/github/webhook` and
  `/api/dispatch/v1/*` (apex records proxied; `EXECUTION_MODE=own` since
  2026-10-10). Paths it does not serve pass through to Vercel.
- `EXECUTION_MODE=shadow` passes every request through. That is the rollback,
  with no DNS or route change.
- `/__control-plane/health` is public and reports only liveness, mode and the
  deployed commit.
  `?deep=1` probes GitHub (anonymous and as the App), Pusher, storage and
  Redis from the Worker; it needs `Authorization: Bearer <CRON_SECRET>`, is a
  404 without it, and reports each probe as a status or ok/fail word, never
  upstream error text (`index.test.ts`).
- The anonymous GitHub probe (`anonymousGithubProbe`) reads `rate_limited`
  and stays healthy when GitHub answers 429, or 403 with
  `x-ratelimit-remaining: 0`. Unauthenticated calls share a per-IP budget, and
  a Worker's egress IP is shared, so another tenant can spend it. Any other
  non-200 fails the deep health, including a 403 with budget left, which is
  what a missing User-Agent looks like. The App probe covers the authenticated
  path.
- `.github/workflows/deploy-control-plane.yml` deploys the Worker on every
  successful Production deployment of the web app, at that deployment's SHA and
  so after its migrations, and fails unless `/__control-plane/health?deep=1`
  then reports that SHA with every dependency healthy.
- It ships code with `wrangler versions upload` + `versions deploy`, never
  `wrangler deploy`. Its token (`CF_DISPATCH_API_TOKEN`) can upload and deploy
  Worker versions but cannot reach the zone's Workers Routes. That was verified
  on 2026-10-10: `wrangler deploy` with the token uploaded the script, then
  failed on `/zones/<id>/workers/routes` with "No access". A versions upload
  and deploy with the same token succeeded. Routes and the custom domain are
  changed only by hand, with `wrangler deploy` from an account login.
- A failed Worker deploy is noticed by the release health watcher, not by the
  workflow's own red run. After a release's grace (`CONTROL_PLANE_GRACE_MINUTES`),
  the watcher degrades the release and files a degradation task when the web
  app runs the release and `/api/deploy-identity` reports the Worker on
  another commit (`release-health-watcher.test.ts`).
- `/api/deploy-identity` reports the Worker's commit and mode beside the web
  app's SHA, read from the shallow health with a short timeout. `null` means
  the Worker did not answer; `lockstep: false` means the two hosts run
  different code.

**Acceptance criteria**:
- AC-4: GIVEN a production web deploy of SHA X THEN the Worker's health reports
  commit X and `ok: true` (`index.test.ts`; the workflow enforces it).
- AC-3: GIVEN the Vercel project paused WHEN a runner claims through
  buildd.dev THEN the claim is answered by the Worker against production
  Postgres. Passed on 2026-10-10 (artifact `control-plane-cutover-evidence`).
- AC-5: GIVEN GitHub answers the Worker's anonymous call 403 with
  `x-ratelimit-remaining: 0` WHEN `?deep=1` runs THEN `github` is `rate_limited`
  and does not fail the probe; GIVEN a 403 with budget left THEN it fails
  (`index.test.ts`).

## 3. One owner per state machine

**Capability statement**: Each table MUST have one owning system, so neither
the kernel nor any other code advances state another system owns.

**Invariants**:
- Living Specs tables (`artifacts`, `artifact_revisions`, `artifact_reads`,
  `artifact_links`, `specs`, `spec_revisions`, `spec_approvals`) are written only
  by Living Specs modules: `apps/web/src/lib/artifact-*`,
  `packages/core/artifact-*`, `apps/web/src/lib/specs/` and the artifact and
  spec routes. The workflow kernel (`apps/web/src/lib/workflow/`) writes none
  of them.
- Writers outside Living Specs that predate the boundary are listed in
  `LEGACY` in `state-ownership.test.ts`. The list may only shrink: a listed file
  that stops writing fails the test until it is removed from the list.
- Kernel tables (`workflow_deliveries`, `workflow_effects`,
  `workflow_transitions`, ...) are written only under
  `apps/web/src/lib/workflow/`, enforced by `workflow-write-sites.test.ts` with
  an empty allowlist. `state-ownership.test.ts` pins that this guard exists,
  runs on every diff and covers the delivery, effect and transition tables.

**Out of scope, on purpose**:
- Task and worker lifecycle *columns* (`tasks.status`, `workers.status`, ...).
  Per `workflow-state-kernel.md` they are fact caches and projections that many
  doors write today, not kernel-owned state, so claiming them here would be a
  guard that fails on day one.
- References held by other systems' rows, such as `missions.contextArtifactIds`.
  A reference is an id, not Living Specs state: writing it does not write an
  artifact. Typed links (`artifact_links`, artifacts-and-sharing.md §9) are the
  canonical form, and the legacy column is read but no longer extended.

**Code surface**:
- `packages/core/__tests__/state-ownership.test.ts`
- `packages/core/__tests__/workflow-write-sites.test.ts`

## Verification gaps

1. The bundle carries the whole TypeScript compiler, through the reviewer's
   copy review (`apps/web/src/lib/copy-review.ts`), which is most of its
   18.6 MB (3.4 MB gzip). Startup CPU against the Workers limit is unmeasured.
2. Only the claim path was exercised end to end in production. Webhook and
   Dispatch callbacks pass end to end only locally (AC-1, under wrangler dev);
   in production they were exercised only to their auth refusals.
3. While the web app is down, crons, MCP and every non-execution route wait for
   it; `after()` work gets the Workers 30 s `waitUntil` limit.
