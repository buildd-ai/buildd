---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# failure-classification-contract intentionally fails: the packages/core two-arg
# classifyFailure(error, pattern) contract this doc specifies was never built.
# apps/web/src/lib/failure-classifier.ts is a pre-existing, unrelated single-arg
# classifier — it does not satisfy this assertion. Fix the assertion only once
# the §1 primitive actually ships. select-failover, manual-provider-switch, and
# backend-policy-tests pass because §§3/6 (bidirectional direction, manual
# override) genuinely shipped, exactly as scoped — see "What Has Shipped" /
# "What Has Not" below for the full picture. Per-assertion classification
# flags any passing assertion under this doc's non-terminal `partially` status
# as code_ahead regardless of whether the doc's own prose already says so, so
# these three are suppressed below (skip_until) rather than left to redispatch
# a reconcile-spec task against an already-accurate doc; re-verify and either
# renew or drop the suppression once failure-classification-contract ships and
# the doc can promote to `implemented`.
assertions:
  - id: "select-failover"
    type: "symbol"
    name: "pickFailoverBackend"
    path: "packages/core/backend-policy.ts"
    skip_until: "2026-12-19"
    skip_reason: "pickFailoverBackend genuinely shipped (§3/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "manual-provider-switch"
    type: "route"
    method: "POST"
    path: "/api/tasks/[id]/reassign"
    file: "apps/web/src/app/api/tasks/[id]/reassign/route.ts"
    skip_until: "2026-12-19"
    skip_reason: "The manual reassign route genuinely shipped (§6/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "backend-policy-tests"
    type: "test_file"
    path: "packages/core/__tests__/backend-policy.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "backend-policy.test.ts genuinely covers the shipped pickFailoverBackend (§3/What Has Shipped) — this isn't a false positive — but the doc must stay 'partially' until failure-classification-contract ships, so this assertion will pass forever under a non-terminal status. failure-classification-contract is the assertion that tracks real remaining progress."
  - id: "failure-classification-contract"
    type: "symbol"
    name: "classifyFailure"
    path: "packages/core/failure-classification.ts"
---
# Backend Failover Policy

**Status:** Partially Implemented — bidirectional budget + auth failover shipped through a shared pure decision function (`pickFailoverBackend`); the unified failure classifier, per-workspace policy config, and audit-trail history this design called for were not built (see What Has Shipped / What Has Not)
**Related:** `packages/core/backend-policy.ts`, `apps/web/src/lib/backend-failover.ts`, `packages/core/auth-error-classifier.ts`, `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/tasks/[id]/reassign/route.ts`, `docs/design/retry-continuity.md`

---

## Problem

Buildd runs tasks on two agent backends (`tasks.backend`: `claude` | `codex`) backed by separate credential pools. When one backend cannot execute, the other often can.

**A Claude task that fails on an expired OAuth token used to be stranded.** The worker reported `Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid`, the task went `failed`, and nothing retried it — even when the workspace had working Codex credentials sitting right there. **This is now fixed**: the worker-report route classifies the failure with `classifyAuthErrorSeverity` (`packages/core/auth-error-classifier.ts`) and, when another backend is usable, fails the task over automatically (see What Has Shipped). Process crashes and transient runner faults are still not covered by anything general — the one infra-shaped case that recovers on its own, `sandbox_mount_gap`, is a narrow hardcoded reset with no backend switch, not a trigger a workspace can opt into.

Meanwhile the one failover that *does* exist used to be invisible: it silently rewrote `tasks.backend`, so the UI showed a Codex run for a task the user created as Claude with no explanation. (Addressed — the task peek panel renders a backend chip plus a "Switched to X after Y" note driven by `context.failedOverFrom`/`context.failoverReason`.)

## What Has Shipped

Two failure classes now trigger automatic, bidirectional failover, both routed through one pure decision function:

- **`packages/core/backend-policy.ts` `pickFailoverBackend`** — the "single declarative policy" the Implementation sketch called `resolveFailover`; it shipped under this name instead (naming divergence, not a missing feature). Pure: given `from`, the team's `enabledBackends` mask, and observed `BackendAvailability` per candidate, it walks `DISPATCHABLE_BACKENDS` in registry (`failoverPriority`) order and returns the first candidate that is configured, unpaused, and not busy — or `null` plus a `blocked` reason per rejected candidate. Because it iterates the registry instead of hardcoding a direction, **Codex→Claude now works** (`backend-policy.test.ts`: "moves a Codex-walled task to Claude"), closing the direction gap below.
- **`apps/web/src/lib/backend-failover.ts` `resolveFailoverBackend`** — the DB half `pickFailoverBackend` is deliberately kept ignorant of: reads active provider pauses (`backendPauses` table plus the legacy Claude budget columns via `getActiveBackendPauses`) and credential presence (`hasClaudeCredential`, `hasCodexCredential`), then hands `pickFailoverBackend` a complete picture.
- **Budget trigger** (`apps/web/src/app/api/workers/[id]/route.ts`, the worker-report PATCH handler): a budget/rate-limit failure calls `resolveFailoverBackend` and, if it returns a backend, re-queues the task on it, stamping `context.failedOverFrom` / `context.failoverReason: 'budget_exhausted'`.
- **Auth trigger** (same route): a `code_failure` is run through `classifyAuthErrorSeverity` (`packages/core/auth-error-classifier.ts` — a reused, pre-existing credential-health classifier, not a new one) against the error string, falling back to the worker's `workerErrorTraces` when the top-level error doesn't match. A non-`'none'` severity calls the same `resolveFailoverBackend` and, on a hit, re-queues on the new backend, stamping `context.authFailoverApplied: true` to block a second flip on the same task — a hardcoded single hop, not the configurable `maxAttempts` §4 below describes.
- **Manual override** — `POST /api/tasks/[id]/reassign` (assertion `manual-provider-switch`) accepts `{ backend }` and switches it, as specified.
- Related but distinct, unchanged from before: `maskBackend` (`packages/core/backend-policy.ts`) redirects based on `teams.enabledBackends`. That is a **team enablement toggle, not a failure fallback**, and both triggers above still apply it — `resolveFailoverBackend` is always called with the team's mask, so failover can never route to a backend the team disabled.

## What Has Not

- **No unified `classifyFailure(error, pattern)`.** The design's crux — one classifier producing `budget | auth | infra | task` — was never built (`failure-classification-contract` still fails; leave it unsuppressed until it ships). The two triggers above reuse two separate, narrower, pre-existing classifiers instead of one shared one. There is no explicit `task`-class default-deny table; the same effect holds only because nothing else currently calls into failover.
- **`infra` is not a class anything can opt into.** `sandbox_mount_gap` recovers on its own, but as a hardcoded reset-to-pending with no backend switch and no relation to `pickFailoverBackend` — not the opt-in trigger §1/§2 describe. A generic crash/OOM/network-fault trigger does not exist.
- **No per-workspace `failoverPolicy` config.** The `workspaces.gitConfig.failoverPolicy` shape in §2 (enabled/triggers/direction/maxAttempts) does not exist anywhere in the codebase. Both triggers run unconditionally for every workspace with the credentials to support them — broader than the documented current-behavior-preserving default (`{ triggers: ["budget"], direction: "claude_to_codex" }`), not an opt-in on top of it.
- **No `context.failoverHistory` audit array.** §4/§6 describe one growing list of hops; what shipped instead is a scalar `context.failedOverFrom` / `context.failoverReason` pair per failover, plus one boolean guard per trigger type (`authFailoverApplied`). A manual reassign records a third, still-different field, `context.switchedBackendFrom` — not an append to the history array §6 asked for. Nothing tracks hops across trigger types, so a budget flip followed later by an auth flip on the new backend is not counted against any shared limit.
- **`tryFlipToCodex` (claim route) was not replaced.** The Implementation sketch asked for both ad-hoc flip sites to call the new shared resolver. Only the worker-report route (PATCH) was migrated; `apps/web/src/app/api/workers/claim/route.ts`'s `tryFlipToCodex` is still its own one-directional, Claude→Codex-only, in-memory flip, independent of `pickFailoverBackend`.
- **No workspace settings UI** for a policy that doesn't exist yet.
- **No mission-timeline note per hop.** The peek panel's "Switched to X after Y" line is the only surfaced signal; nothing writes a timeline entry.

## Proposal

The sections below are the original design rationale. Annotations mark what actually shipped against what stayed aspirational — see What Has Shipped / What Has Not for the full accounting.

### 1. Failure classification

**Not shipped as designed.** No unified classifier exists; see What Has Not.

Classify every terminal worker failure into exactly one class. This is the crux of the design: **misclassification is what makes failover dangerous**, because retrying a deterministic bug on another backend burns credits to reach the same failure.

| Class | Examples | Failover? |
|---|---|---|
| `budget` | rate limit, quota/credit exhausted, seat limit | **Yes** — shipped |
| `auth` | 401, invalid/expired OAuth, "Not logged in" | **Yes** — shipped |
| `infra` | runner crash, OOM, network fault, session lost | **Opt-in** — not shipped (only the hardcoded `sandbox_mount_gap` case recovers) |
| `task` | agent completed with an error, test failures, bad diff, permission denial | **No** — the other backend will fail identically |

Classification derives from `workerErrorTraces.pattern` (already populated) plus the worker `error` string. `task` is the **default** for anything unrecognized: unknown failures must not trigger spend on a second backend.

### 2. Configuration (per-workspace opt-in)

**Not shipped.** See What Has Not — both triggers run unconditionally, with no `workspaces.gitConfig.failoverPolicy` to opt into or narrow.

Add `failoverPolicy` to `workspaces.gitConfig` (jsonb — no migration needed), defaulting to today's behavior so nothing changes on rollout:

```jsonc
{
  "failoverPolicy": {
    "enabled": true,
    "triggers": ["budget", "auth"],        // subset of budget|auth|infra
    "direction": "bidirectional",           // "claude_to_codex" | "bidirectional"
    "maxAttempts": 1                        // failover hops per task, total
  }
}
```

Default when absent — exactly current behavior:
`{ enabled: true, triggers: ["budget"], direction: "claude_to_codex", maxAttempts: 1 }`

Team-level `enabledBackends` still applies **after** policy resolution: failover may never route to a backend the team disabled.

### 3. Direction

**Shipped.** `bidirectional` is not a config toggle — it's simply how `pickFailoverBackend` always behaves, since it walks the registry rather than hardcoding a source/target pair. Codex→Claude works with no separate code path. Both directions are gated on target-credential availability (`hasCodexCredential` and `hasClaudeCredential`, both shipped in `apps/web/src/lib/codex-credential.ts` / `claude-credential.ts`).

### 4. Attempt budget and loop safety

**Partially shipped.** See What Has Not — each trigger type has its own hardcoded single-hop guard (`authFailoverApplied` for auth; the budget path has no equivalent boolean, relying instead on the target actually being unpaused), not the configurable `maxAttempts` or shared `failoverHistory` this section describes.

The load-bearing safety property. A task must never ping-pong between backends.

- Track hops in `context.failoverHistory: [{ from, to, reason, ts }]`.
- Refuse failover when `failoverHistory.length >= maxAttempts`.
- Refuse failover to a backend already present in `failoverHistory` (hard stop on cycles, independent of `maxAttempts`).
- Keep the existing per-workspace concurrency throttle so a mass credential outage can't stampede the second backend.
- On budget exhaustion, `maxAttempts` is per-task, not per-workspace — a global outage should strand tasks as `failed`, not silently drain the other pool.

### 5. Observability

Failover is a spend decision made on the user's behalf and must be legible:

- Surface `failedOverFrom` / `failoverReason` in the task peek and full task page. **Shipped.**
- Emit a mission-timeline note on each hop. **Not shipped.**
- Never mutate the user's original intent silently. **Shipped, with different copy than sketched below**: instead of folding the note into the chip text, the peek panel shows the plain backend chip plus a separate line — "Switched to Codex after Claude hit its budget." — driven by `context.failedOverFrom`/`context.failoverReason`.

### 6. Manual override

**Shipped**, but not wired into the audit trail this section asks for — see What Has Not. `POST /api/tasks/[id]/reassign` accepts `{ backend }` to retry on a chosen backend, surfaced in the peek as a one-click "Switch to codex". Manual switches are user intent, so they are not counted against any attempt guard; the route records `context.switchedBackendFrom` rather than appending to `failoverHistory` (which does not exist).

## Implementation sketch

1. `packages/core/failure-classification.ts` — `classifyFailure(error, pattern) → FailureClass`. Pure, unit-tested against a corpus of real trace excerpts. **Build this first**; the rest is worthless without it. **Not built** — the two triggers that shipped reuse narrower pre-existing classifiers instead (see What Has Not).
2. `packages/core/backend-policy.ts` — add `resolveFailover({ task, workspace, failureClass, credentials }) → { to, reason } | null`. Pure and exhaustively testable. **Shipped, under the name `pickFailoverBackend`**, with a different signature (`{ from, enabledBackends, availability, now }`) — the DB read that resolves `credentials`/`availability` lives one layer up, in `apps/web/src/lib/backend-failover.ts`'s `resolveFailoverBackend`, so the core function stays pure.
3. Replace the flip logic in the worker PATCH route and `tryFlipToCodex` with calls to `resolveFailover`. Behavior-preserving under default config. **Half-shipped**: the worker PATCH route (`apps/web/src/app/api/workers/[id]/route.ts`) now calls `resolveFailoverBackend` for both budget and auth triggers. `tryFlipToCodex` in the claim route was left untouched — it is still its own one-directional, ad-hoc flip.
4. Workspace settings UI for the policy. **Not built** — there is no policy to configure yet.

## Open questions

1. **Should `infra` default on?** It's the class most likely to be transient, but also the one most likely to recur identically (a broken runner breaks both backends). Leaning **off by default**. Still open — no `infra` trigger exists to default one way or the other.
2. **Cost asymmetry.** Failing a large task over to a pricier backend can spend materially more than the user expected. Do we need a cost ceiling on failover, or is `maxAttempts: 1` sufficient? Still open — no cost ceiling exists, and the shipped guards are hardcoded single-hop rather than a configurable `maxAttempts`.
3. **Does a failed-over task keep its worktree/branch?** See `docs/design/retry-continuity.md` — failover still resets the task to `pending` and re-claims fresh, discarding partial work, for both the budget and auth triggers that shipped. For a budget failure mid-run that may be the wrong call. Still open.
4. **Role-level override.** Roles already carry `defaultBackend`; should they also carry a failover policy, or is workspace-level the right altitude? Still open — moot until some form of policy configuration exists at all.

## Non-goals

- Model-tier fallback within Claude (opus→sonnet). Different axis; `model` is Claude-only and never selects a provider.
- Using failover to work around a team's `enabledBackends` mask.
- Automatic retry of `task`-class failures on any backend.
