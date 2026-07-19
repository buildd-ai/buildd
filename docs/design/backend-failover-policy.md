# Backend Failover Policy

**Status:** Proposed
**Related:** `packages/core/backend-policy.ts`, `apps/web/src/app/api/workers/[id]/route.ts`, `apps/web/src/app/api/workers/claim/route.ts`, `apps/web/src/app/api/tasks/[id]/reassign/route.ts`, `docs/design/retry-continuity.md`

---

## Problem

Buildd runs tasks on two agent backends (`tasks.backend`: `claude` | `codex`) backed by separate credential pools. When one backend cannot execute, the other often can — but today that recovery only happens for a single, narrow failure class.

**A Claude task that fails on an expired OAuth token is stranded.** The worker reports `Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid`, the task goes `failed`, and nothing retries it — even when the workspace has working Codex credentials sitting right there. The same is true for process crashes and transient runner faults. A human has to notice and hit Retry.

Meanwhile the one failover that *does* exist is invisible: it silently rewrites `tasks.backend`, so the UI shows a Codex run for a task the user created as Claude with no explanation. (Partially addressed — the task peek panel now renders a backend chip plus a "Switched to X after Y" note from `context.failedOverFrom`.)

## Current state

Two mechanisms, both **budget/rate-limit only** and both **Claude→Codex only**:

1. **Persistent flip — worker PATCH** (`apps/web/src/app/api/workers/[id]/route.ts`). When a worker reports Claude budget/rate-limit exhaustion, and `hasCodexCredential(workspace)` holds, and the task isn't already Codex: set `tasks.backend='codex'`, reset `status='pending'`, and stamp `context.failedOverFrom='claude'`, `context.failoverReason='budget_exhausted'`, `context.budgetExhausted`.
2. **In-memory flip — claim** (`apps/web/src/app/api/workers/claim/route.ts`, `tryFlipToCodex`). Budget-exhausted Claude tasks are redirected to Codex at claim time, throttled to at most one Codex worker per workspace.

Related but distinct: `maskBackend` (`packages/core/backend-policy.ts`) redirects based on `teams.enabledBackends`. That is a **team enablement toggle, not a failure fallback** — it must not be conflated with this policy.

Gaps:
- No trigger for **auth** failures (the most recoverable class — the other backend has independent credentials).
- No trigger for **crash**/transient failures.
- No **Codex→Claude** direction.
- No attempt budget — the flip is implicitly one-shot only because the target backend isn't itself a failover source.
- No per-workspace configuration; behavior is hardcoded.

## Proposal

A single declarative policy, evaluated in one place, replacing the two ad-hoc flip sites.

### 1. Failure classification

Classify every terminal worker failure into exactly one class. This is the crux of the design: **misclassification is what makes failover dangerous**, because retrying a deterministic bug on another backend burns credits to reach the same failure.

| Class | Examples | Failover? |
|---|---|---|
| `budget` | rate limit, quota/credit exhausted, seat limit | **Yes** — today's behavior |
| `auth` | 401, invalid/expired OAuth, "Not logged in" | **Yes** — independent credential pools |
| `infra` | runner crash, OOM, network fault, session lost | **Opt-in** — usually retryable, but may recur |
| `task` | agent completed with an error, test failures, bad diff, permission denial | **No** — the other backend will fail identically |

Classification derives from `workerErrorTraces.pattern` (already populated) plus the worker `error` string. `task` is the **default** for anything unrecognized: unknown failures must not trigger spend on a second backend.

### 2. Configuration (per-workspace opt-in)

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

`bidirectional` unlocks Codex→Claude, which has no path today. Both directions must be gated on target-credential availability (`hasCodexCredential` already exists; a `hasClaudeCredential` equivalent is needed).

### 4. Attempt budget and loop safety

The load-bearing safety property. A task must never ping-pong between backends.

- Track hops in `context.failoverHistory: [{ from, to, reason, ts }]`.
- Refuse failover when `failoverHistory.length >= maxAttempts`.
- Refuse failover to a backend already present in `failoverHistory` (hard stop on cycles, independent of `maxAttempts`).
- Keep the existing per-workspace concurrency throttle so a mass credential outage can't stampede the second backend.
- On budget exhaustion, `maxAttempts` is per-task, not per-workspace — a global outage should strand tasks as `failed`, not silently drain the other pool.

### 5. Observability

Failover is a spend decision made on the user's behalf and must be legible:

- Surface `failedOverFrom` / `failoverReason` in the task peek and full task page. *(Peek: done.)*
- Emit a mission-timeline note on each hop.
- Never mutate the user's original intent silently: the backend chip should read "Codex (failed over from Claude)", not just "Codex".

### 6. Manual override

Complementary and already shipped: `POST /api/tasks/[id]/reassign` accepts `{ backend }` to retry on a chosen backend, surfaced in the peek as a one-click "Switch to codex". Manual switches are user intent, so they are **not** counted against `maxAttempts`, but they should append to `failoverHistory` for auditability.

## Implementation sketch

1. `packages/core/failure-classification.ts` — `classifyFailure(error, pattern) → FailureClass`. Pure, unit-tested against a corpus of real trace excerpts. **Build this first**; the rest is worthless without it.
2. `packages/core/backend-policy.ts` — add `resolveFailover({ task, workspace, failureClass, credentials }) → { to, reason } | null`. Pure and exhaustively testable.
3. Replace the flip logic in the worker PATCH route and `tryFlipToCodex` with calls to `resolveFailover`. Behavior-preserving under default config.
4. Workspace settings UI for the policy.

## Open questions

1. **Should `infra` default on?** It's the class most likely to be transient, but also the one most likely to recur identically (a broken runner breaks both backends). Leaning **off by default**.
2. **Cost asymmetry.** Failing a large task over to a pricier backend can spend materially more than the user expected. Do we need a cost ceiling on failover, or is `maxAttempts: 1` sufficient?
3. **Does a failed-over task keep its worktree/branch?** See `docs/design/retry-continuity.md` — failover currently resets to `pending` and re-claims fresh, discarding partial work. For a budget failure mid-run that may be the wrong call.
4. **Role-level override.** Roles already carry `defaultBackend`; should they also carry a failover policy, or is workspace-level the right altitude?

## Non-goals

- Model-tier fallback within Claude (opus→sonnet). Different axis; `model` is Claude-only and never selects a provider.
- Using failover to work around a team's `enabledBackends` mask.
- Automatic retry of `task`-class failures on any backend.
