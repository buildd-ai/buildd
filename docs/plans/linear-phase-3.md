# Plan — Linear Phase 3a (inbound webhook: label → task, close → cancel)

**Status:** In progress — branch `feat/linear-phase-3` (based on `main`).
**Design:** `docs/design/linear-hierarchy-ingest.md` (Phase 3)
**Spec:** `docs/specs/work-tracker-integration.md` §3 (inbound webhooks)
**Scope:** The **inbound Linear webhook** only. A labeled Linear issue creates a
linked buildd task; closing the issue cancels the linked task if it's still open.
**Zero behaviour change for any workspace without a Linear webhook configured** —
the route 404s/no-ops and nothing else in the app changes.

> Design-doc Phase 3 bundles the inbound webhook **and** the full Linear
> graph-import subsystem (paginated walk, persisted cursor, 429 backoff,
> reconcile into initiatives/missions/tasks, actor-based echo suppression,
> remove/move handling). That is a separate, much larger effort — split out as
> **Phase 3b** below so this slice stays reviewable and independently shippable.

---

## Ground truth (verified against code 2026-07-26)

- **`external_links` + helpers exist** (Phase 1): `linkExternal`,
  `getLinksForEntity`, `findLinkByExternal` in `packages/core/external-links.ts`.
  `(provider, externalId)` is partial-unique → idempotent upsert.
- **`secrets.purpose='webhook_token'` already exists**; `secrets` is
  team/account/workspace-scoped with a `label`. Per CLAUDE.md we add a webhook
  secret as a `secrets` row — **no new credential table**.
- **`tasks`**: `status` defaults `'pending'` (free text; terminal set used
  elsewhere = `'completed' | 'failed' | 'cancelled'`). `creationSource` already
  includes `'webhook'`. `externalIssueId`/`externalIssueUrl` columns exist.
  Insert needs only `workspaceId` + `title`.
- **`workTrackerConfig`** (`workspaces.workTrackerConfig`) already carries
  `{ provider, connectorId?, inboundLabel? }` — `inboundLabel` is the §3 trigger
  label (default `'buildd'`).
- **Signature pattern** to mirror: `verifyWebhookSignature` in `lib/github.ts`
  (HMAC-SHA256 via `crypto.subtle`, hex).
- **Outbound path** (`postLinearCompletionComment`) reads `tasks.externalIssueId`
  and calls Linear `issueUpdate(id:)` — so the created task's `externalIssueId`
  must be the Linear issue **UUID** (`data.id`), not the `ABC-12` identifier.

## Decisions

1. **Workspace resolution via a path param:** `POST /api/webhooks/linear/[workspaceId]`.
   The Linear payload carries no buildd workspace id, and the §3 secret is
   *per workspace*, so the workspace must be in the URL for an O(1), unambiguous
   lookup. (Minor deviation from the spec's literal `.../linear/route.ts` path —
   noted here; the workspace id is not a secret, the HMAC signing secret is.)
2. **Signing secret:** `secrets` row `purpose='webhook_token'`, `label='linear'`,
   `workspaceId=<ws>`; `encryptedValue` = Linear's webhook signing secret. No secret
   configured → `401` (cannot authenticate the delivery).
3. **Idempotency key = Linear issue UUID (`data.id`).** `findLinkByExternal('linear',
   data.id)` before create; the `(provider, externalId)` upsert is the true guard.
   Sequential retries (Linear's redelivery model) → check-then-insert is enough;
   the rare concurrent double-delivery is caught by a compensating check on the
   upsert's returned `builddEntityId` (delete the loser task).
4. **"Labeled":** Linear has no discrete `labeled` action — it sends
   `action:'update'` (or `'create'`) with the current label set. Rule: if the issue
   **currently carries** `inboundLabel` and no link exists → create. Idempotency
   makes re-fires safe.
5. **"Closed":** issue `state.type ∈ {completed, canceled}` (or `action:'remove'`)
   → cancel the linked task via an **atomic** `UPDATE … WHERE status NOT IN
   (terminal)` (no read-then-write; AC-3's "completed task unchanged" is the WHERE
   guard). This also makes echo-suppression free for this slice: the only loop
   (outbound closes a *completed* task's issue → inbound cancel) no-ops on the
   terminal guard.
6. **Replay guard:** reject deliveries whose `webhookTimestamp` is >60s from now.
7. **Provider mismatch / unknown issue → `200` no-op** (never error on a
   well-formed but irrelevant delivery); **bad signature → `401`, no mutation**.

## Files

- `apps/web/src/lib/linear-webhook.ts` (NEW) — pure/DI-testable:
  `verifyLinearSignature(rawBody, signature, secret)` (constant-time hex compare),
  `parseLinearIssueEvent(payload, inboundLabel)` → normalized
  `{ kind: 'label' | 'close' | 'ignore', issueId, issueUrl, title }`, and
  `handleLinearIssueEvent(db, ctx, event, deps)` (the create/cancel core).
- `apps/web/src/app/api/webhooks/linear/[workspaceId]/route.ts` (NEW) — thin:
  raw-body read → resolve ws + secret → verify sig + timestamp → parse → dispatch.
- Tests (TDD, first): `linear-webhook.test.ts` (signature ✓/✗, parse matrix,
  create idempotency AC-1/AC-2, close→cancel terminal-guard AC-3) + a light route
  test (404 unknown ws, 401 no-secret/bad-sig AC-4, 200 no-op wrong provider).

## Tests (write first)

- **verifyLinearSignature**: correct HMAC → true; wrong secret/body/sig → false.
- **parseLinearIssueEvent**: issue+label present → `label`; state completed/canceled
  or `remove` → `close`; project event / no label / non-issue → `ignore`.
- **handleLinearIssueEvent (DI)**: label + no existing link → one task
  (`creationSource:'webhook'`, `externalIssueId=data.id`) + one link; second
  identical event → no second task (AC-2); close + open link → task cancelled via
  guarded UPDATE; close + already-completed → UPDATE affects 0 rows (AC-3);
  ignore → no writes.
- **route**: unknown ws → 404; ws without `webhook_token` → 401; bad signature →
  401 + no handler call (AC-4); valid sig, wrong provider → 200 no-op.

## Rollout

1. `linear-webhook.ts` + tests (core is pure — no DB).
2. Route + light route test.
3. `bun test` (targeted) + full-suite guard for the mock.module leak class + `tsc`.
4. PR → `dev`; verify `build` gate; merge.

## Phase 3b (follow-up — NOT in this PR)

- **GitHub inbound** (§3 GitHub half): `issues` `labeled`/`closed` on the existing
  `/api/github/webhook` route (reuses signature + workspace-by-repo resolution).
- **Graph import**: paginated Linear graph walk → reconcile into
  initiatives/missions/tasks via `external_links`; imported project-missions
  `orchestrationMode='manual'`; persisted cursor + 429 backoff; `remove`/`move`
  → mark linked rows stale.
- **Full echo suppression**: drop events whose actor is buildd's OAuth identity;
  `externalUpdatedAt` watermark + `lastPushedHash` gate (needed once import writes
  back, not for label→task).
- **Webhook setup UI**: generate/store the `webhook_token`, surface the
  per-workspace webhook URL + inbound status in `WorkTrackerSection.tsx`.
