# Native Initiatives Tier + Optional Linear Sync

**Status:** Phase 0 Implemented (native tier — initiatives + rollup + MCP + UI + KB corpus, PRs #1446/#1452). Phase 1 Shipped (link layer + token refresh, PR #1459; plan archived at `docs/plans/archive/linear-phase-1.md`). Phase 2 Shipped (read-back tracking panel, PR #1470). Phase 3 split into **3a** (inbound Linear webhook — in progress, `docs/plans/linear-phase-3.md`) and **3b** (graph import + GitHub inbound + echo suppression — Proposed). Phase 4 Proposed.
**Correction:** `external_links` was listed under Phase 0 below but was **not** built there (shipped Phase 0 = initiatives tier only). It is owned by **Phase 1** — see the Phase 1 plan.
**Related:**
- `docs/specs/work-tracker-integration.md` — the shipped/partial work-tracker contract; §3 inbound webhook is a Phase-3 prerequisite here
- `packages/core/db/schema.ts` — `missions` (~545-607, esp. `parentMissionId:559`, `externalIssueId/Url:596-597`, `orchestrationMode`, `costBudgetUsd`, `scheduleId`, `workingBranch`, `releasedAt`), `tasks` (~610-697, `missionId:645`, `externalIssueId/Url:616-617` — note: **no `teamId`**), `connectors` (~1595-1667)
- `packages/core/mission-helpers.ts` — `computeMissionProgress:70-94` (flat task array only), `isDeliverableTask:21-36`
- `apps/web/src/lib/mission-run.ts` — `runMission`; decomposition gate queries direct tasks only (~203-211)
- `apps/web/src/lib/work-tracker.ts` — `getConnectorAccessToken:27-53` (returns null on expiry, no refresh), `postLinearCompletionComment`, the dead `/link-linear` note string (~240)
- `apps/web/src/lib/mcp-connector-refresh.ts` — `refreshMcpConnectorCredential` (working refresher, currently unwired from the read path)
- `apps/web/src/app/app/(protected)/missions/[id]/page.tsx` — where the tracking panel renders
- `apps/web/src/app/api/missions/route.ts` — mission list payload (external `/api/buildd/objectives` consumer contract — treat as append-only)

> **Supersedes the earlier "Linear ingest" framing of this file.** That version
> proposed overloading `missions.parentMissionId` to represent initiatives and
> claimed "no new tables / no new computation." An adversarial review verified
> both claims false against the code (see Problem). This revision builds a
> **native, execution-free initiatives tier first**, with Linear as one optional
> adapter on top.

---

## Problem

Two gaps, and the obvious cheap fix is a trap.

**Gap 1 — buildd has no standalone way to organize work above a single mission.**
`missions.parentMissionId` (schema.ts:559) exists but nothing populates it as a
planning hierarchy, and there is **no rollup**: `computeMissionProgress`
(mission-helpers.ts:70-94) consumes a flat task array; no caller aggregates across
sub-missions. So a team with no external tracker cannot express or track
"initiative → its projects → their tasks" inside buildd at all.

**Gap 2 — teams who plan in Linear can't see progress against a Linear goal
inside buildd.** Linear sync today is push-only (PR merge → comment + state flip,
`work-tracker.ts`); buildd reads nothing back; the inbound webhook is specced but
unbuilt (`work-tracker-integration.md` §3); and `/link-linear` is advertised to
users (`work-tracker.ts:240`) but **has no handler** — a live dead-end.

**The trap:** representing an initiative as a `missions` row (the tempting
"reuse `parentMissionId`, no new table") is unsafe. A mission carries the full
execution engine — `costBudgetUsd`, `orchestrationMode` default `'auto'`,
`scheduleId`, `workingBranch`, `primaryPrUrl`, `releasedAt`, `dependsOnMissionId`
/`gateCondition`, `requiresReview` (schema.ts:551-601). An "initiative-mission"
would inherit an orchestrator, a heartbeat cron, a git branch, a budget, and a
release trigger. Worse, `runMission`'s decomposition gate queries only *direct*
tasks by `missionId` (mission-run.ts:203-211), so an initiative with zero direct
tasks would not be detected as pre-filed and the organizer would **flatten it into
build tasks**. And it would report `progress: 0` because no sub-mission rollup
exists. Overloading also reintroduces — untyped — the exact layer the
objectives→missions collapse removed.

## Proposal

A native, **execution-free** initiatives tier above missions, plus a generic
external-link mapping table, with Linear as one optional adapter. `mission =
project` and `task = issue` are unchanged.

**Locked decisions (from product, this revision):**
1. **Fixed one level.** `initiative → mission(=project) → task(=issue)`. No
   generic/recursive work-item tree, no portfolios/OKRs yet.
2. **Stable-subset fidelity.** Map only initiative/project/issue + progress/state.
   **Not** cycles, sub-projects, cross-project issues, or custom workflow states.
   buildd complements Linear; it does not mirror the full graph.

### Schema (all additive / nullable — no backfill, no NOT NULL on live rows)

- **`initiatives`** — a pure planning container with **none** of the mission
  execution columns: `id`, `teamId`, `workspaceId?`, `title`, `description`,
  `status` (`active|paused|completed|archived`), `priority`, `progressCache?`
  (denormalized, refreshed on child change), `createdByUserId`, timestamps.
  Because it has no orchestration fields, it **cannot** trip the orchestrator,
  heartbeat, release, or budget logic — the safety is structural, not a guard.
- **`missions.initiativeId`** — nullable FK → `initiatives`, `onDelete: 'set
  null'`. Null = behaves exactly as today. This is the whole coupling to missions.
- **`external_links`** — generic provider mapping:
  `(provider, buildd_entity_type, buildd_entity_id, external_id, external_url,
  external_updated_at, last_pushed_hash)`, with a **partial unique index** on
  `(provider, external_id) WHERE external_id IS NOT NULL`. One table absorbs four
  otherwise-open problems: Linear's project↔initiative **many-to-many** (a single
  self-FK can't model it), **multi-provider** links (Linear + GitHub on one
  entity), **idempotency** (`ON CONFLICT DO UPDATE`), and **echo-loop
  suppression** (`external_updated_at` watermark + `last_pushed_hash`).

### Rollup (new code — the doc no longer pretends this is free)

`computeInitiativeProgress(initiativeId)` recurses over child missions'
`computeMissionProgress` results and caches to `initiatives.progressCache`. A
parent with both direct tasks and child missions is out of scope (initiatives have
no tasks by construction).

### Linear as one optional adapter

Sync rides the existing `WorkTrackerProvider` seam (`work-tracker.ts`), extended
with read (`fetchProgress`) and reconcile (`fetchGraph`) methods; buildd core
reconciles into `initiatives`/`missions`/`tasks` via `external_links`. No
Linear-specific lifecycle code. buildd stays authoritative after import — Linear
is a read-only mirror shown in a panel; it never silently overwrites a
user-edited native field.

**Crux:** *the value is the native tier, not the Linear projection.* Phase 0 must
be provably useful with the Linear connector **uninstalled**. If it isn't, we've
built a worse Linear instead of a stronger buildd. Everything Linear is additive
on top and must never be a prerequisite for native hierarchy value.

## Implementation sketch (each phase shippable, defaults no-op)

**Phase 0 — Native initiatives tier. Zero Linear. ⭐ LOAD-BEARING. ✅ SHIPPED.**
Migration (`bun db:generate`, commit files): `initiatives` table + nullable
`missions.initiativeId` (+ `artifacts.initiativeId`). `computeInitiativeProgress`
helper. UI to create/roll-up initiatives and assign missions. Team-scoped
initiative KB corpus (follow-up, #1452). Proven with no connector installed;
existing missions (`initiativeId = null`) behave identically. **Note:**
`external_links` was originally listed here but moved to Phase 1 — it was not built
in Phase 0.

**Phase 1 — Make linking real. ✅ SHIPPED (PR #1459).** ⟶ plan archived at `docs/plans/archive/linear-phase-1.md`.
Create the `external_links` table (moved from Phase 0). Implement the real link
action (retire the dead `/link-linear` advertisement) writing to `external_links`
(+ dual-write the mission column). Wire `getConnectorAccessToken` →
`refreshMcpConnectorCredential` on expiry; fix `deriveStatus` so a dead credential
(`tokenExpiresAt` null + `lastVerificationError`) surfaces as a reconnect banner
distinct from a transient error.

**Phase 2 — Read-back tracking panel. ✅ SHIPPED (PR #1470).** `fetchLinearProgress`
+ two `tracker-progress` routes; `TrackerProgressPanel` on `missions/[id]` and the
initiative view renders **only** when an `external_link` exists (cheap server-side
gate) → no-op for everyone else; client-fetched so Linear latency never blocks the
page; best-effort, never breaks the page.

**Phase 3a — Inbound Linear webhook. ⟶ plan `docs/plans/linear-phase-3.md`.**
The specced §3 `POST /api/webhooks/linear/[workspaceId]` (label→task, close→cancel):
per-workspace HMAC signing secret (`secrets` purpose `webhook_token`, label
`linear`), idempotent on the Linear issue UUID via `external_links`, atomic guarded
cancel. No graph import.

**Phase 3b — Graph import + GitHub inbound + echo suppression.** Import walks the
Linear graph (paginated, backoff on 429) into the native tier; imported
project-missions default `orchestrationMode = 'manual'` so the heartbeat can't
spawn workers until a human runs them. Idempotent via `external_links` `ON
CONFLICT DO UPDATE` (never read-then-write; no `db.transaction()` on neon-http).
Persist a cursor so a >cap subtree can resume. Handle `remove`/`move` → mark
linked rows stale/unlinked.

**Phase 4 — DEFER: two-way status.** buildd stays sole writer of execution
status; Linear read-only into buildd except the existing label/close triggers.

## Safety properties

- **Structural orchestration safety:** `initiatives` has no execution columns, so
  no orchestrator/heartbeat/release/budget path can act on an initiative. This
  replaces the fragile "remember to guard every code path" approach.
- **Idempotent + race-safe:** partial unique index on `external_links(provider,
  external_id)` + atomic upsert. Re-import and duplicate webhook deliveries never
  duplicate rows.
- **Bounded import with resume:** hard per-run cap AND a persisted cursor, so
  large subtrees fully ingest across runs; overflow logged, never silently
  dropped.
- **No surprise workers:** import creates rows `pending`; imported
  project-missions are `orchestrationMode='manual'`. Nothing dispatches or spends
  until a human runs it.
- **No silent overwrite:** buildd authoritative post-import; reconcile only fills
  null/empty native fields unless the user opts a link into Linear-authoritative.
- **Echo suppression is structural:** drop inbound events whose actor is buildd's
  OAuth identity; gate writes on `external_updated_at` watermark + `last_pushed_hash`.
- **Token refresh:** refresh once at the start of a backfill/read run; expired
  auth raises a reconnect signal rather than a silent "unavailable."

## Open questions

- **`/api/buildd/objectives` external contract.** That route/consumer (the
  dispatch UI) is **not in this repo** — only `deriveMissionHealth`'s value set is
  pinned as a contract (`mission-helpers.test.ts`). Before any hierarchy field
  touches the mission payload: does the dispatch UI need to see the initiative
  layer, and at which level? *Lean: mission payload stays append-only; initiatives
  are a new field/endpoint, never a change to existing mission shape. Add a
  golden-shape snapshot test before Phase 0 touches the payload.*
- **`initiatives.workspaceId` — required or null?** Missions can be
  workspace-null (coordination). Should an initiative span workspaces? *Lean:
  nullable, team-scoped like missions, so an initiative can group missions across
  repos.*
- **Reconcile authority when a link is Linear-authoritative.** For links a user
  explicitly hands to Linear, which planning fields sync down (title/description/
  status) and how are conflicts surfaced? *Lean: title/description/status only,
  last-writer-wins with a visible "updated from Linear" marker; defer real
  conflict UI.*

## Non-goals

- **No** initiative identity on the `missions` row, and **no** `missions.type`
  discriminator — an execution-free `initiatives` table instead (the guard-every-
  path approach is too easy to break).
- **No** generic/recursive work-item tree, portfolios, or OKRs (fixed one level).
- **No** Linear cycles, sub-projects, cross-project issues, or custom workflow
  state mapping (stable subset).
- **No** two-way status sync or field-level conflict resolution in v1.
- **No** blanket Linear-workspace sync — import is opt-in per initiative/project.
- **No** Linear-only import endpoint that bypasses the provider seam — reconcile
  through `external_links` + `WorkTrackerProvider` so GitHub/Jira are additive.
