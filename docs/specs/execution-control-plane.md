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
  `POST /api/dispatch/v1/resolve|receipts`. No other route is served.
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
- AC-2: the router serves exactly the execution routes (`index.test.ts`).

## 2. Cutover (not built)

Nothing routes to the Worker yet. Cutover needs, in order: the Worker deployed
with the web app's secrets (Doppler is the source); the execution routes sent to
it (edge path routing on buildd.dev, so runners and GitHub change nothing);
one owner of the workflow-effect drain at a time, switched like
`dispatch_transport`; and AC-1 run against the deployed Worker with the web
deployment paused.

## Verification gaps

1. The bundle carries the whole TypeScript compiler, through the reviewer's
   copy review (`apps/web/src/lib/copy-review.ts`), which is most of its
   18.6 MB (3.4 MB gzip). Startup CPU against the Workers limit is unmeasured.
2. Only the claim path was exercised end to end; webhook and Dispatch
   callbacks were exercised only to their auth refusals.
