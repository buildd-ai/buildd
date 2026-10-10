---
title: Execution Control Plane
status: draft
owner: max
last_verified: 2026-10-10
summary: Authorized execution (claims, heartbeats, results, webhooks, Dispatch callbacks) MUST keep moving while the web app is down, served by a separate Worker running the same handlers.
domain: tasks
surfaces: [apps/control-plane/src/index.ts, apps/control-plane/src/next-server-shim.ts, apps/control-plane/wrangler.jsonc]
related: [workflow-state-kernel, task-dispatch-authority, artifacts-and-sharing]
keywords: [control plane, extraction, cloudflare worker, web outage, execution path, ownership boundary, living specs, kernel, dispatch, cutover]
verified_by: [apps/control-plane/src/index.test.ts]
supersedes: []
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
- `server-only`, `dotenv` and `@ast-grep/napi` resolve to stubs. The native
  `@ast-grep/napi` consumer already falls back when its binary cannot load.
- Config comes from `process.env` (`nodejs_compat_populate_process_env`); the
  database driver is the same neon-http driver as on Vercel.

**Acceptance criteria**:
- AC-1: GIVEN apps/web is not running WHEN a runner claims, heartbeats and
  completes a task against the control plane THEN the task and worker end
  `completed` (`apps/control-plane/scripts/web-down-e2e.sh`, run 2026-10-10
  under wrangler dev against migrated Postgres: PASS).
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
- `/__control-plane/health` is public and reports only liveness and mode.
  `?deep=1` probes GitHub (anonymous and as the App), Pusher, storage and
  Redis from the Worker; it needs `Authorization: Bearer <CRON_SECRET>`, is a
  404 without it, and reports each probe as a status or ok/fail word, never
  upstream error text (`index.test.ts`).
- Lockstep with the web app's production commit is owed: until the release
  workflow deploys it, the Worker is redeployed by hand after each release.

**Acceptance criteria**:
- AC-3: GIVEN the Vercel project paused WHEN a runner claims through
  buildd.dev THEN the claim is answered by the Worker against production
  Postgres. Passed on 2026-10-10 (artifact `control-plane-cutover-evidence`).

## Verification gaps

1. The bundle carries the whole TypeScript compiler, through the reviewer's
   copy review (`apps/web/src/lib/copy-review.ts`), which is most of its
   18.6 MB (3.4 MB gzip). Startup CPU against the Workers limit is unmeasured.
2. Only the claim path was exercised end to end in production; webhook and
   Dispatch callbacks were exercised only to their auth refusals.
3. While the web app is down, crons, MCP and every non-execution route wait for
   it; `after()` work gets the Workers 30 s `waitUntil` limit.
