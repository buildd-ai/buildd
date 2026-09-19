---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
# pr-refresh-seam and task-read-refresh-tests pass, but neither is evidence
# that this spec's migration shipped: refreshStaleWorkersForWorkspaces
# predates this doc (it backs home/page.tsx from PR #1883), and
# tasks/page.test.ts tests unrelated mission-budget plumbing, not the
# refresh-before-query behavior Step 1 calls for. See "Implementation
# Status" below for what has actually shipped.
assertions:
  - id: "pr-terminal-accessor"
    type: "symbol"
    name: "isPrTerminal"
    path: "apps/web/src/lib/task-presentation.ts"
  - id: "pr-refresh-seam"
    type: "symbol"
    name: "refreshStaleWorkersForWorkspaces"
    path: "apps/web/src/lib/pr-state-refresh.ts"
    skip_until: "2026-12-19"
    skip_reason: "Predates this doc (backs home/page.tsx since PR #1883); passing is not evidence Step 1 shipped. Structurally will always pass while status stays partially — see Implementation Status below."
  - id: "task-read-refresh-tests"
    type: "test_file"
    path: "apps/web/src/app/app/(protected)/tasks/page.test.ts"
    skip_until: "2026-12-19"
    skip_reason: "Tests unrelated mission-budget plumbing, not the refresh-before-query behavior Step 1 calls for. Structurally will always pass while status stays partially — see Implementation Status below."
---
# Derived-State Accessors: Single-Accessor Contract

**Status:** Partially — D4 has shipped; D1, D3, and D5's Step 5 have not. See "Implementation Status" below.
**Related:**
- `docs/design/status-reconciliation.md` (PR #1630/1633) — data-model ruling this builds on; do not contradict it
- `apps/web/src/lib/task-presentation.ts` — canonical task derivation module
- `apps/web/src/lib/stage.ts` — canonical chip stage + "is PR terminal?" derivation (`deriveStage`). Moved out of `StageChip.tsx` since this doc was written — see the note in D1 below. `StageChip.tsx` now only re-exports the `Stage` type so server code can call `deriveStage` without importing a `'use client'` module.
- `apps/web/src/lib/pr-state-refresh.ts` — refresh seam (`refreshStaleWorkersForWorkspaces`, in `apps/web/src/lib/pr-reconcile.ts`: `refreshWorkerMergeStateIfStale`)
- `apps/web/src/lib/mission-helpers.ts` — mission health/display derivation functions (`deriveMissionHealth`, `deriveTaskHealthSignal`, `deriveMissionDisplayState`, `healthToGroup`, `isCountableHealthTask`)
- `packages/core/mission-helpers.ts` — a second, separate `mission-helpers.ts` that now hosts `recalculateOverall`, `evaluateGoalCriteria`, and `isDeliverableTask` (publicly exported, used by `apps/web/src/lib/mission-completion.ts`, `mission-evaluation.ts`, `heartbeat-prepass.ts`, `explain.ts`, and `missions/[id]/page.tsx`). This split postdates the doc — see D5.
- `apps/web/src/lib/mission-criteria-eval.ts` — auto-eval `judgeWithLLM` (this file lives under `apps/web/src/lib/`, not `packages/core/` as originally written here)
- `apps/web/src/app/api/missions/[id]/evaluate/route.ts` — manual eval now delegates to `evaluateCriteriaNow` (imported from `mission-criteria-eval.ts`); the private `judgeWithLLM` fork this doc describes in D4 has been deleted
- Audit artifact 483c5069 — "Derived-state duplication & refresh coverage audit" (2026-08-29)

---

## Implementation Status (reconciled 2026-09-19, last confirmed current by PR #2496)

If you were dispatched here to reconcile this doc again: run `git log -- docs/design/derived-state-accessors.md` first. As of this writing the last three commits against this file (PR #2485, #2489, #2496, all 2026-09-19) already did this reconciliation and added the `skip_until` suppression below — a fresh dispatch here is very likely ledger lag (the conformance checker re-running before a same-day merge lands), not new drift. Only redo the table below if `git log` shows a commit *after* PR #2496 that isn't accounted for here.

| Decision | Status |
|---|---|
| D1 — `isPrTerminal` accessor | **Not implemented.** The four divergent inline predicates (`TaskCard.tsx`, `missions/page.tsx`, `missions/[id]/page.tsx`, `tasks/[id]/page.tsx`) are all still present and still forked exactly as described below. No `isPrTerminal` export exists anywhere in the codebase. |
| D2 — two `deriveDisplayStatus` exports | Resolved by the original finding — no code change was ever required. Still true today: one `deriveDisplayStatus`, in `task-presentation.ts`. |
| D3 — `no-stale-pr-read` lint rule | **Not implemented.** There is no `eslint-rules/` directory, no `.eslintrc*`, and no ESLint config file anywhere in this repo — `bun run lint` runs `next lint` against whatever Next.js's default config resolves to. Standing up the chosen enforcement mechanism now requires introducing ESLint config from scratch, not just adding one rule to an existing one. |
| D4 — `judgeWithLLM` duplicate | **Done.** `evaluate/route.ts` has no private `judgeWithLLM` or `LLM_MODEL` constant; it calls `evaluateCriteriaNow` from `mission-criteria-eval.ts`, the same function the auto-eval path uses. Both paths resolve the model via `resolveTierEntrySync('budget')`. |
| D5 — intentional duplication | `isCountableHealthTask` vs `isDeliverableTask` no longer live in the same file (see D5 below for the corrected pairing) — neither function carries the cross-referencing JSDoc Step 5 called for. |
| Step 1 — wire the three unguarded pages | **Not implemented.** `tasks/page.tsx`, `missions/page.tsx`, and `initiatives/[id]/page.tsx` still have no `refreshStaleWorkersForWorkspaces`/`refreshWorkerMergeStateIfStale` call. The refresh-coverage gap this doc opens with is still live. |
| Step 3 lint fixture | **Not implemented** (blocked on D3). |

`pr-refresh-seam` and `task-read-refresh-tests` pass structurally (the symbol and the test file both exist), but neither shipped because of this doc: `refreshStaleWorkersForWorkspaces` predates it (it backs `home/page.tsx` since PR #1883), and `tasks/page.test.ts` tests mission-budget plumbing unrelated to the refresh-before-query behavior Step 1 describes. Status stays `partially` rather than `implemented` until D1, D3, and Step 1 land.

Because per-assertion conformance classification cannot read this prose, both assertions will keep re-evaluating as `code_ahead`/open on every conformance run for as long as `status: partially` stands — that is expected, not a sign this document has drifted again. A future "reconcile" pass on this file only has work to do once D1, D3, or Step 1's status above actually changes; until then, re-verify against the Implementation Status table rather than re-deriving it from scratch.

---

## Problem

The audit (artifact 483c5069) found **three unguarded list pages** and **four divergent inline "is PR done?" predicates** — the same class of bug that caused merged PRs #1874–1878 to render as OPEN in the Activity feed. The Activity feed was fixed (PR #1883) by adding `refreshStaleWorkersForWorkspaces` to `home/page.tsx`. The task list, mission list, and initiative detail page have the identical gap. Convention said "call the refresh function before querying workers." Convention has now failed four times across unrelated surfaces.

The status-reconciliation spec (PR #1630/1633) ruled the data model: `workers.mergedAt` and `workers.prLifecycleStatus` are event-sourced facts, correct to store. That spec is about what to store. This spec is about the **presentation half it did not cover**: how a surface is permitted to obtain a derived fact, and what prevents the next surface from repeating the gap.

---

## Current State

**The two tables below are a frozen snapshot from audit artifact 483c5069 (2026-08-29)** — file:line citations reflect the codebase as it stood then and have drifted with ordinary code growth since. They document what the audit found, not live state. For what has and hasn't shipped since, see "Implementation Status" above; in particular the "Is PR terminal?" and "LLM criteria judge" rows below are unchanged from the audit but D1 and D4 (respectively) now describe their current, reconciled state.

### Derived facts inventory (from audit artifact 483c5069)

| Derived fact | Canonical symbol | File:line | Callers | Divergence |
|---|---|---|---|---|
| Task display status | `deriveDisplayStatus` | `task-presentation.ts:48` | `TaskCard.tsx:225`, `tasks/page.tsx:311`, `missions/[id]/TaskPanel.tsx:142`, `tasks/[id]/page.tsx:281` | None — single export, no fork. `StageChip.tsx:53 deriveStage` overlaps on `running`/`waiting_input` cases but serves a different downstream type. |
| Task chip stage | `deriveStage` | `StageChip.tsx:53` | `TaskCard.tsx:229`, `home/page.tsx:1976` | Not duplicated. |
| Task lifecycle phase | `deriveTaskPhase` | `task-presentation.ts:110` | `tasks/[id]/page.tsx:402`, `missions/[id]/TaskPanel.tsx:134` | Not duplicated. `isBlocked` prop computed independently at each caller (`unresolvedDeps.length > 0`) — latent only; both paths agree today. |
| **"Is PR terminal?" (done/closed)** | `StageChip.tsx:67` — `isMerged = !!mergedAt \|\| prLifecycleStatus === 'merged'` | `StageChip.tsx:67` | — | **Divergent (active bug).** Four sites inline their own predicate, each wrong in a different way — see §D1. |
| Mission operating health | `deriveMissionHealth` | `mission-helpers.ts:241` | `home/page.tsx:644`, `missions/[id]/page.tsx:313` | Not duplicated. |
| Mission task signal | `deriveTaskHealthSignal` | `mission-helpers.ts:95` | `missions/[id]/page.tsx` | Not duplicated. |
| Mission display state | `deriveMissionDisplayState` | `mission-helpers.ts:137` | `missions/[id]/page.tsx:327` | Not duplicated. |
| Mission list group | `healthToGroup` | `mission-helpers.ts:197` | `home/page.tsx:673`, `MissionGrid.tsx:156,174,275,453` | Not duplicated. |
| Criteria overall verdict | `recalculateOverall` | `mission-criteria-eval.ts:33` | `mission-criteria-eval.ts:287`, `evaluate/route.ts:368` (imports same fn) | Not duplicated. |
| **LLM criteria judge** | `judgeWithLLM` (private) | `mission-criteria-eval.ts:42` | auto-eval path | **Divergent (active bug).** `evaluate/route.ts:68` defines its own private copy hardcoded to `'claude-haiku-4-5-20251001'`. |
| "Is task health-countable?" | `isCountableHealthTask` (private) | `mission-helpers.ts` | `deriveTaskHealthSignal` | Legitimately distinct from `isDeliverableTask` — different predicate, different purpose. See §D5. |

### Refresh coverage (from audit artifact 483c5069)

| Page | Refresh called? | Mode | Gap |
|---|---|---|---|
| `home/page.tsx` | Yes — `refreshStaleWorkersForWorkspaces(wsIds)` line 458 | Blocking `await` | ✅ |
| `missions/[id]/page.tsx` | Yes — `refreshWorkerMergeStateIfStale` lines 157–160 | Blocking `await` | ✅ |
| `tasks/[id]/page.tsx` | Yes — `refreshWorkerMergeStateIfStale` line 153 | Blocking `await` | ✅ |
| `api/tasks/route.ts` | Yes — `refreshStaleWorkersForWorkspaces` line 21 | Non-blocking (`.catch`) | ⚠️ Stale on first poll; corrects on next |
| `api/missions/[id]/route.ts` | Yes — `refreshStaleWorkers` line 130 | Non-blocking (`.catch`) | ⚠️ Same caveat |
| **`tasks/page.tsx`** | **No** | — | **❌ Active gap** |
| **`missions/page.tsx`** | **No** | — | **❌ Active gap** |
| **`initiatives/[id]/page.tsx`** | **No** | — | **❌ Active gap** |

---

## Proposal

**Crux:** The "is PR terminal?" predicate is forked across five sites, and the refresh call is absent from three pages. Both gaps stem from the same cause — there is no structural barrier that forces a new surface to route through the canonical accessor. Adding a fourth wrapper function or a fifth call site will not prevent a sixth. The fix must make the wrong path visible at the point of violation, not after the fact.

The five decisions below are ordered by impact. Steps in §Migration are written so each can be shipped and reverted independently.

---

## D1 — The "is PR terminal?" accessor

**Status: not implemented.** Everything below still describes the codebase as of 2026-09-19 — the divergence this section documents is still live.

**Finding:** The canonical predicate lives inline in `deriveStage`, in `apps/web/src/lib/stage.ts` (originally at `StageChip.tsx:67` when this doc was written; `deriveStage` and its predicate were later extracted into their own module so server components could call it without importing a `'use client'` file — `StageChip.tsx` now only re-exports the `Stage` type):

```ts
const isMerged = !!mergedAt || prLifecycleStatus === 'merged';
const isClosed = prLifecycleStatus === 'closed';
```

Four other sites still define their own version (unchanged since this doc was written, modulo line drift):

| File | Predicate | What it misses |
|---|---|---|
| `TaskCard.tsx` | `prLifecycleStatus === 'merged' \|\| prLifecycleStatus === 'closed'` | `mergedAt` — a worker with `mergedAt` set but null `prLifecycleStatus` shows the wrong inline label |
| `missions/[id]/page.tsx` | `!latestWorker?.mergedAt && prLifecycleStatus !== 'closed'` | `prLifecycleStatus === 'merged'` guard absent — inverts the intent |
| `missions/page.tsx` | `w?.prUrl && !w?.mergedAt && w?.prLifecycleStatus !== 'closed'` | Same |
| `tasks/[id]/page.tsx` | `!taskWorkers[0]?.mergedAt && taskWorkers[0]?.prLifecycleStatus !== 'closed'` | Same |

**Resolution (still to be done):** Extract `isPrTerminal(worker: { mergedAt: string | null; prLifecycleStatus: string | null }): boolean` as a named export from `task-presentation.ts`. The body is the canonical predicate, currently inline in `stage.ts`'s `deriveStage`:

```ts
export function isPrTerminal(w: { mergedAt: string | null; prLifecycleStatus: string | null }): boolean {
  return !!w.mergedAt || w.prLifecycleStatus === 'merged' || w.prLifecycleStatus === 'closed';
}
```

All four divergent sites are updated to call `isPrTerminal(worker)`. `StageChip.tsx:67` is updated to call it internally so there is exactly one implementation.

**Fate of the divergent inline predicates:** Deleted — not aliased. Each caller imports `isPrTerminal` from `task-presentation.ts`.

**Why `task-presentation.ts` and not `stage.ts`:** `stage.ts` exists to compute the richer `Stage` enum consumed by chip UI (see D5's discussion of `deriveStage` vs `deriveDisplayStatus`). `task-presentation.ts` is already the canonical pure-function derivation module (see its file header: "All UI surfaces consume these pure functions — never fork display logic locally") and is what the four divergent page-level sites already import from for other derivations. Moving the extracted function there avoids adding a fifth import source. `stage.ts`'s `deriveStage` calls the imported function; nothing changes for consumers of `StageChip`/`deriveStage`.

---

## D2 — The two `deriveDisplayStatus` exports

**Finding:** The task brief named two files: `task-presentation.ts` and `task-timestamps.ts`. The audit found that `task-timestamps.ts` **does not exist** in this codebase — it was previously a re-export barrel that has since been merged or removed.

**Resolution:** There is one `deriveDisplayStatus`, at `task-presentation.ts:48`. No deduplication is needed. No aliasing is needed. This decision is recorded here so the follow-on implementation task does not search for the second file or attempt to reconcile two exports.

**What callers may not do:** Any new module that re-exports `deriveDisplayStatus` under a different name, or that reimplements the same `taskStatus + workerStatus` -> `string` logic locally, violates the contract. The lint rule in §D3 does not cover this case directly; it must be caught in code review. The function's JSDoc already states "Callers must not fork their own logic — this is the single source of truth" (`task-presentation.ts:46`).

---

## D3 — The refresh seam (structural enforcement)

**Status: not implemented.** The three pages named below still have no refresh call, and this repo currently has no ESLint config at all (no `.eslintrc*`, no `eslint.config.*`, no `eslint-rules/` directory — `bun run lint` runs `next lint` against Next.js's built-in default). Standing up Option B now means introducing ESLint configuration from scratch in addition to writing the rule.

**Finding:** Three pages read `prLifecycleStatus`/`mergedAt` from worker rows without calling the refresh function first. Convention has failed four times. The answer must be structural.

**Three options considered:**

**Option A — Shared query helper (wrapper function):** A single `queryWorkersWithRefresh(wsIds, queryFn)` function that calls `refreshStaleWorkersForWorkspaces` before delegating to the query. Pages must use this helper instead of calling the DB directly.

*Why rejected:* The existing `refreshStaleWorkersForWorkspaces` is already a wrapper — it is the shared helper. The three unguarded pages simply did not call it. Adding a second wrapper level does not change the failure mode: a new page author can still bypass it. Convention-as-wrapper has already failed.

**Option B — Lint rule:** A custom ESLint rule (`no-stale-pr-read`) that bans direct reads of `.prLifecycleStatus` and `.mergedAt` on worker objects inside Next.js server component files (`apps/web/src/app/**/(protected)/**/*.tsx` and `apps/web/src/app/**/(protected)/**/*.ts`) unless the file also imports from `@/lib/pr-state-refresh` or `@/lib/pr-reconcile`. Violation fails CI.

*Why chosen:* Makes the bypass visible at the point of violation (CI fails, not after a user reports a bug). Narrower than a blanket ban — it applies only to page-level components, not to the derivation module itself. The rule is a one-time implementation cost; every future page gets it for free.

*Escape hatch:* `// eslint-disable-next-line no-stale-pr-read -- <non-empty reason>` with a required non-empty reason comment (enforced by the rule's `requireDescription` option). An empty reason is a lint error. A meaningful reason (e.g. "API route — non-blocking refresh already called") is preserved as a searchable audit trail.

**Option C — Branded/opaque type:** A `FreshWorkerRow` branded type that only the refresh functions can produce. `deriveStage` and `isPrTerminal` accept `FreshWorkerRow` instead of raw `WorkerRow`. Passing a raw DB result to a chip function is a TypeScript error.

*Why not chosen as the primary mechanism:* Requires touching every Drizzle query result shape that reaches a chip. The schema emits plain `typeof workers.$inferSelect` rows; branding them requires wrapper types in every call chain. This is a multi-hundred-line change for three missing `await` calls. The audit itself noted it is "disproportionate." It remains the strongest long-term guarantee if the lint rule proves insufficient in practice.

**Chosen approach: Option B (lint rule), with Option A as the immediate fix.**

The lint rule is the structural enforcement. But the three unguarded pages must be fixed now — before the lint rule is written — because the bug is live. The migration sequence is: fix the immediate gaps first (Step 1), add the structural guard second (Step 3), so CI catches the next gap before it ships.

**Lint rule specification:**

- **Rule name:** `no-stale-pr-read`
- **Plugin:** custom ESLint plugin at `eslint-rules/no-stale-pr-read.js` in the repo root
- **Trigger:** Any member expression reading `.prLifecycleStatus` or `.mergedAt` (case-sensitive) in a file matching `apps/web/src/app/**/(protected)/**/(page|layout|loading).tsx`
- **Pass condition:** The file's import declarations include at least one import from `'@/lib/pr-state-refresh'` or `'@/lib/pr-reconcile'`
- **Allowlist (never trigger in):** `apps/web/src/lib/pr-state-refresh.ts`, `apps/web/src/lib/pr-reconcile.ts`, `apps/web/src/components/StageChip.tsx`, `apps/web/src/lib/task-presentation.ts`, `apps/web/src/lib/task-timestamps.ts` (gone but listed defensively), any `*.test.ts` / `*.test.tsx`
- **Escape hatch:** `// eslint-disable-next-line no-stale-pr-read -- <non-empty reason>` — rule enforces that the reason is non-empty (≥ 4 chars after `--`)
- **CI gate:** Added to `.eslintrc` in the `rules` block with `'error'` severity; `bun run lint` already runs in CI via `build.yml`

---

## D4 — `judgeWithLLM` duplicate

**Status: implemented.** `evaluate/route.ts` no longer defines a private `judgeWithLLM` or `LLM_MODEL` constant. It imports `evaluateCriteriaNow` from `apps/web/src/lib/mission-criteria-eval.ts` and calls that instead — a larger unification than exporting `judgeWithLLM` alone (the whole evaluation flow, not just the LLM judge call, now runs through one function), but it closes the gap this section describes: manual/MCP-triggered eval and auto-eval now resolve the model the same way, via `resolveTierEntrySync('budget')`. `judgeWithLLM` itself remains private to `mission-criteria-eval.ts`, called only internally by `evaluateCriteriaNow`.

**Original finding (for context):** `mission-criteria-eval.ts` resolved the LLM model via `resolveTierEntrySync('budget').model`. `evaluate/route.ts` defined its own private copy that hardcoded `const LLM_MODEL = 'claude-haiku-4-5-20251001'`. Active divergence: a `manage_model_tiers` update to the budget tier would be picked up by auto-eval but silently ignored by manual/MCP-triggered eval.

**Fate of the duplicate:** Deleted — not aliased. The hardcoded `LLM_MODEL` constant went with it.

**Where the canonical function lives:** `mission-criteria-eval.ts` under `apps/web/src/lib/` (not `packages/core/` — see the Related section above). It already held the type-registering call and the `resolveTierEntrySync` call.

---

## D5 — What stays duplicated (intentional)

The following pairs were found in the audit and are **not** collapsed. They serve distinct purposes. The follow-on refactor must not over-flatten them.

**`deriveDisplayStatus` (task-presentation.ts:48) vs `deriveStage` (StageChip.tsx:53):**
Two concepts. `deriveDisplayStatus` produces a plain string matching task DB status values (e.g. `'running'`, `'completed'`) for timestamp labeling and non-chip UI surfaces. `deriveStage` produces a richer `Stage` enum that adds PR lifecycle stages (`OPEN`, `CI`, `DONE`) and subject-gate states (`SUBJECT_DEAD`, `MISSION_BUDGET`). They overlap on the `running`/`waiting_input` derivation logic, but they return incompatible types to incompatible consumers. Collapsing them would either lose PR lifecycle detail from the chip or add unnecessary PR-awareness to every timestamp-label call site.

**`isCountableHealthTask` (`apps/web/src/lib/mission-helpers.ts`, private) vs `isDeliverableTask` (`packages/core/mission-helpers.ts`, exported):**
`isCountableHealthTask` gates health signal derivation — it excludes docs/chore tasks from NOMINAL/FAILING/STALLED/BLOCKED counts because those tasks don't have deliverable PRs and would distort the signal. `isDeliverableTask` gates progress percentage computation — it includes a task in the denominator if it has a concrete output to ship. The predicates differ: a chore task may be deliverable (it has an output) but not health-countable (it is not a signal task). Collapsing them changes health signal semantics for workspaces with chore-heavy missions.

Since this doc was written, the two functions have ended up in **different files** — `apps/web/src/lib/mission-helpers.ts` (web-app-local health/display derivations) and `packages/core/mission-helpers.ts` (shared, cross-package mission logic) are now separate modules with the same base name. `isCountableHealthTask` is still private to its file; `isDeliverableTask` is now a public export of `packages/core/mission-helpers.ts`, consumed by `apps/web/src/lib/mission-completion.ts`, `mission-evaluation.ts`, `heartbeat-prepass.ts`, `explain.ts`, and `missions/[id]/page.tsx`. Neither is "already contained" in the sense this doc originally claimed. Step 5's JSDoc cross-reference has not been added to either function — the reasoning below still applies, it just needs to point across packages instead of within one file.

**`isBlocked` computed in two places:**
`deriveTaskPhase` (task-presentation.ts:110) receives `isBlocked: boolean` as a parameter. `deriveStage` (StageChip.tsx:53) receives it as a prop. At each call site (e.g. `tasks/[id]/page.tsx:347`) the predicate `unresolvedDeps.length > 0` is evaluated once and passed to both. This is not duplication of the predicate — it is duplication of a prop assignment. Both functions consume the same boolean from the same source. No change needed.

---

## Migration

Each step is independently shippable and revertible. The proving-ground step (Step 1) would have caught the #1878 bug class: it adds the refresh call to the three unguarded pages and ships a test that fails when the refresh is absent.

### Step 1 — Wire the three unguarded pages (proving-ground)

**Status: not implemented.** `tasks/page.tsx`, `missions/page.tsx`, and `initiatives/[id]/page.tsx` have no refresh call as of 2026-09-19; the bug this step exists to fix is still live.

**What:** Add `await refreshStaleWorkersForWorkspaces(wsIds)` before the worker query in `tasks/page.tsx`, `missions/page.tsx`, and `initiatives/[id]/page.tsx`. Pattern is identical to `home/page.tsx:458`.

`initiatives/[id]/page.tsx` requires resolving a `wsIds` array from the mission's `workspaceId` before the nested worker query (workers are nested under tasks under missions). A `refreshStaleWorkersForWorkspaces([mission.workspaceId])` call before the main query is sufficient.

**Acceptance criteria:**
1. A unit test for each of the three pages mocks `db.query.workers.findMany` returning `{ prUrl: 'https://github.com/…/pull/1', prLifecycleStatus: null, mergedAt: null }` on a completed worker. With the refresh wired, the page renders the stage chip as "Done" (because the refresh updates `mergedAt` in the mock before the query runs). Without the refresh, the chip reads "Open". Test fails if the import from `pr-state-refresh` is removed.
2. `bun test apps/web/src/app/app/(protected)/tasks/page.test.ts` and equivalent mission/initiative tests pass.
3. No new DB columns. No schema migration.

**Revert:** Remove the three `await refreshStaleWorkersForWorkspaces(wsIds)` calls. No downstream impact.

**Why this is the proving ground:** This is the exact change that would have prevented the #1878 regression. It is the smallest effective fix. If landed alone, it fixes the live bug without any other step. Every subsequent step is hardening, not correction.

---

### Step 2 — Extract `isPrTerminal` and delete the four inline forks

**Status: not implemented.** No `isPrTerminal` export exists; all four inline forks are still in place (see D1).

**What:** Add `export function isPrTerminal(w: { mergedAt: string | null; prLifecycleStatus: string | null }): boolean` to `task-presentation.ts` (after `deriveDisplayStatus`). Update `StageChip.tsx:67` to call it. Delete the inline predicates in `TaskCard.tsx:257`, `missions/[id]/page.tsx:268`, `missions/page.tsx:386`, `tasks/[id]/page.tsx:334` and replace with `isPrTerminal(worker)`.

**Acceptance criteria:**
1. `task-presentation.test.ts` covers: `mergedAt` set + null `prLifecycleStatus` → `true`; both null → `false`; `prLifecycleStatus === 'closed'` → `true`.
2. `grep -r "prLifecycleStatus === 'merged'" apps/web/src/` returns only `pr-state-refresh.ts`, `pr-reconcile.ts`, `github/webhook/route.ts`, and the new `task-presentation.ts`. Zero hits in page files or TaskCard.
3. `bun test` green.

**Revert:** Restore the four inline predicates. No schema change, no API change.

---

### Step 3 — Add the `no-stale-pr-read` lint rule

**Status: not implemented.** See D3 — the repo currently has no ESLint config to add this rule to.

**What:** Implement the ESLint rule described in §D3. Add it to `.eslintrc` at `'error'` severity. The three pages from Step 1 already import `pr-state-refresh`, so they pass immediately. The rule's first real enforcement test: add a new page that reads `prLifecycleStatus` without importing the refresh module → CI fails.

**Acceptance criteria:**
1. `eslint-rules/no-stale-pr-read.js` exists and exports the rule.
2. `bun run lint` passes on the current codebase with the rule enabled.
3. A test fixture at `eslint-rules/__tests__/no-stale-pr-read.test.js` covers: (a) page file with `.prLifecycleStatus` + no refresh import → error; (b) page file with `.prLifecycleStatus` + refresh import → no error; (c) `StageChip.tsx`-pattern allowlist path → no error; (d) `// eslint-disable-next-line no-stale-pr-read -- reason` → no error; (e) `// eslint-disable-next-line no-stale-pr-read --` (empty reason) → error.

**Revert:** Remove the rule from `.eslintrc` and delete `eslint-rules/no-stale-pr-read.js`.

---

### Step 4 — Unify `judgeWithLLM` in `evaluate/route.ts`

**Status: implemented.** See D4.

**What:** Export `judgeWithLLM` from `mission-criteria-eval.ts`. Delete the private copy in `evaluate/route.ts:68` (including `LLM_MODEL` constant). Import the canonical function.

**Acceptance criteria:**
1. `grep -r "claude-haiku-4-5-20251001" apps/web/src/` returns zero hits.
2. `grep "judgeWithLLM" apps/web/src/app/api/missions/\[id\]/evaluate/route.ts` shows an import line, not a function definition.
3. Manual eval and auto-eval use the same model — confirm with `resolveTierEntrySync('budget').model` at a breakpoint.

**Revert:** Restore the private copy in `evaluate/route.ts`. No schema change, no API change.

---

### Step 5 — Document `isCountableHealthTask` vs `isDeliverableTask`

**Status: not implemented.** Neither function carries the cross-referencing JSDoc; see D5 for the corrected file locations to reference.

**What:** Add a JSDoc comment to each private function in `mission-helpers.ts` that names the other and explains why they are separate predicates. No logic change.

**Acceptance criteria:**
1. `isCountableHealthTask` JSDoc states: "Distinct from isDeliverableTask (line N) — this gates health signal computation; that gates progress percentage. A chore task may be deliverable but is not health-countable."
2. `isDeliverableTask` JSDoc states: "Distinct from isCountableHealthTask — see above."
3. `bun test` green (no behavior change).

**Revert:** Remove the JSDoc. Zero risk.

---

## Open Questions

**Q1: Should the lint rule also block API route files?**
`api/tasks/route.ts` and `api/missions/[id]/route.ts` read `prLifecycleStatus`/`mergedAt` non-blockingly (fire-and-forget refresh). Blocking on those routes would slow API responses. The lint rule as specified targets only `(page|layout|loading).tsx` files, not route handlers. If the non-blocking API behavior is considered insufficient and we want to enforce blocking refresh there too, the rule's file pattern must be extended. Lean: leave API routes out of scope — the ⚠️ status is documented and acceptable for a polling client.

**Q2: Is the opaque `FreshWorkerRow` type worth adding on top of the lint rule?**
Probably yes in the medium term — TypeScript enforcement is stronger than ESLint enforcement (tsc runs before lint, cannot be `eslint-disable`d away). Lean: defer to a follow-on spec. The lint rule is sufficient to close the immediate gap; the opaque type can be designed once the lint rule is in place and the refactor cost is clearer.

---

## Non-goals

- **No new DB columns.** `mergedAt` and `prLifecycleStatus` are event-sourced facts per the status-reconciliation spec; this doc does not add cached conclusions.
- **No cron.** Refresh is read-through only.
- **Web app only.** The runner's own worker state is not in scope.
- **No reconciliation of `isBlocked` computation.** The dual-computation in callers of `deriveTaskPhase` + `deriveStage` is latent only and not worth a structural change.
- **No changes to mission-health functions.** `deriveMissionHealth`, `deriveTaskHealthSignal`, `deriveMissionDisplayState`, `healthToGroup` are all correctly encapsulated; no action needed.
- **No API or type changes in `packages/shared`.** All changes are within `apps/web/src/`.
