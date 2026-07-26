# Machine-Checkable Spec Conformance

**Status:** Proposed
**Related:**
- `scripts/check-schema-drift.ts` — prior art: machine-readable declaration vs introspectable state
- `apps/runner/src/env-verify.ts` — prior art: declared manifest vs phased runtime checks
- `docs/specs/SPEC-FORMAT.md` — existing spec frontmatter schema
- `docs/design/DESIGN-FORMAT.md` — design doc format this file follows
- `docs/design/worker-mount-isolation.md` — worked example: naming divergence
- `docs/design/loop-until-verified.md` — worked example: silent no-op
- `docs/design/cross-app-assertion-grant.md` — worked example: shipped-while-draft

---

## Problem

Spec status fields are hand-maintained strings with no mechanism binding them to
reality. A 2026-07-25 recon found at least six specs declaring "Proposed" or
"draft — awaiting approval" for features that are fully shipped and
production-patched. Concrete examples:

- `worker-mount-isolation.md` — status "Proposed"; `buildWorkerBwrapArgv` has
  shipped in `bwrap-mount-allowlist.ts`, called from `workers.ts:2098`.
- `loop-until-verified.md` — status "Proposed"; migration 0091 deployed
  `loop_config`, `loop_iteration`, `loop_state`; evaluation logic is live in
  `apps/web/src/app/api/workers/[id]/route.ts`.
- `cross-app-assertion-grant.md` — status "draft — awaiting approval";
  `GET /api/.well-known/jwks.json`, `POST /api/connectors/[id]/assertion`, and
  the rotation cron are all deployed; migration 0079 applied.

These stale statuses rot silently. A reader cannot tell which specs describe
working systems and which describe aspirations. `spec_compare` cannot fix this:
it is prose on one side and vector retrieval on the other; it computes no verdict
server-side. It is a retrieval aid being asked to act as a conformance test.

---

## Current State

Two conformance mechanisms already exist in this repo and share a common shape:
a **machine-readable declaration compared against introspectable state**.

**`scripts/check-schema-drift.ts`** — compares the Drizzle migration snapshot
(declaration) against `information_schema` (introspectable state). Column
present in DB but absent from snapshot → manual DDL not tracked. Column expected
by snapshot but absent → unapplied migration. Exit 0 when clean; exit 1 with a
named diff when not. Runs on release PRs.

**`apps/runner/src/env-verify.ts`** — reads `.buildd/env.yaml` (declaration) and
executes phased verification steps: toolchain present, install succeeds, required
env vars set, readiness command exits 0. Returns a structured `VerifyReport`.
Enforcement is opt-in: only a declared manifest blocks. Auto-detected plans
(no `.buildd/env.yaml`) never fail a runner that did not opt in. The warm gate
cache (keyed by base commit + manifest hash, 10-minute TTL) avoids re-running an
expensive readiness probe for repeat provisions off the same base.

**Reuse vs diverge:**
- The `migration` assertion type (below) borrows check-schema-drift's pattern
  directly: migration file exists on disk + SQL contains the expected identifier.
  The DB-introspection half is excluded from the pre-commit tier (too slow,
  requires credentials) but is included in the CI tier.
- The tiered enforcement structure (pre-commit → CI → cron) mirrors
  env-verify's phase ordering (toolchain → install → env → readiness), where
  earlier phases are cheaper and failures are attributed to the earliest cause.
  The delta gate borrows env-verify's warm-cache key idea — substitute a
  keyed buildd artifact for an in-process map.
- Divergence: check-schema-drift checks ALL tables simultaneously; spec
  conformance is per-doc, per-claim. env-verify is per-repo and runs a single
  manifest; spec conformance runs per-doc and is accumulated across all docs in
  the watch set.

---

## Proposal

**Crux:** the assertion vocabulary. Too narrow and it cannot distinguish a
deployed system from a silent no-op (loop columns exist but are never evaluated).
Too broad and it becomes a second programming language with its own bugs. The
vocabulary must be wide enough to express the three failure modes in the worked
examples below and no wider.

### 1. Assertion Vocabulary

Assertions live in a YAML frontmatter block added to each design or spec doc.
For design docs, the block replaces the existing bold `**Status:**` line as the
machine-readable source of truth; the bold line is deprecated once the
frontmatter is present. For spec docs, `assertions` is a new key added to the
existing frontmatter block.

```yaml
---
status: proposed | accepted | implemented | superseded   # design docs
# OR for spec docs:
# status: draft | active | superseded
assertions:
  - type: <assertion-type>
    # per-type parameters (see below)
---
```

**Six assertion types.** Each is justified by one of the three worked examples;
nothing beyond these six is in scope for this design.

---

#### `symbol` — named export exists at a specific path

```yaml
- type: symbol
  name: buildWorkerBwrapArgv
  path: apps/runner/src/bwrap-mount-allowlist.ts
```

Check: ripgrep for `export.*buildWorkerBwrapArgv` (or `buildWorkerBwrapArgv` as
a named export) in the named file. Pass if at least one match. Fail if file
absent or symbol not found. Budget: filesystem + ripgrep, < 50ms.

---

#### `symbol_reachable` — symbol exists AND is reached from a live entry point

```yaml
- type: symbol_reachable
  symbol: loopState
  entry: apps/web/src/app/api/workers/[id]/route.ts
  as: assign   # optional: read | assign | import  (default: any)
```

Check: ripgrep for `loopState\s*=` (when `as: assign`) in the named entry-point
file. Pass if at least one non-comment assignment match. The `entry` MUST be a
named route handler, cron handler, webhook handler, or top-level component file
— not a utility or type file. This is the assertion type that distinguishes a
deployed symbol from a silent no-op.

`as: assign` is the recommended mode for loop-state assertions: `loopState` must
be assigned from the completion path, not merely imported or mentioned in a type.

Budget: filesystem + ripgrep, < 100ms per assertion.

---

#### `route` — Next.js route file exists and exports a handler

```yaml
- type: route
  method: GET
  path: /api/.well-known/jwks.json
  file: apps/web/src/app/api/.well-known/jwks.json/route.ts
```

Check: file at `file` exists; ripgrep for `export.*\b(GET|POST|PATCH|DELETE)\b`
in that file to confirm a handler is exported. Pass if both hold. Fail if file
absent or no export found.

Budget: filesystem + ripgrep, < 50ms.

---

#### `migration` — Drizzle migration file exists and contains an identifier

```yaml
- type: migration
  number: 91
  contains: loop_config
```

Check (pre-commit tier): glob `packages/core/drizzle/0091_*.sql`; file must
exist; grep for `loop_config` inside it.

Check (CI tier, when DATABASE_URL is available): additionally verify the
migration appears in `drizzle.__drizzle_migrations` — borrowing
check-schema-drift's `appliedCount` approach. A migration file that exists on
disk but has not been applied to the DB is a `partial` assertion result, not a
pass.

Budget: filesystem only in pre-commit (< 50ms); DB query in CI (< 2s).

---

#### `config_key` — env var or config key declared in a specific file

```yaml
- type: config_key
  key: BUILDD_DISABLE_SANDBOX
  file: apps/runner/src/bwrap-mount-allowlist.ts
```

Check: ripgrep for `BUILDD_DISABLE_SANDBOX` in the named file (as a string
literal or identifier). Pass if found. Covers env vars that gate feature
behaviour and must be documented at the call site.

Budget: filesystem + ripgrep, < 50ms.

---

#### `test_file` — test file exists at path

```yaml
- type: test_file
  path: apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
```

Check: file exists on disk. Pass if found. This is deliberately the weakest
assertion — it proves only that someone wrote a test, not that the test covers
the right surface. Use alongside `symbol_reachable` to make the claim stronger.

Budget: filesystem, < 10ms.

---

### 2. Derived vs Declared Status

Status is **computed** from assertion results, not authored. The declared
`status` field is a claim; the checker either validates or refutes it.

| Assertion results | Derived status |
|---|---|
| All assertions pass | `implemented` |
| ≥1 assertion fails, ≥1 passes | `partial` |
| All assertions fail | `failing` |
| No assertions declared | `unverified` |

**CI failure conditions:**

1. Declared `implemented` (or `active` for spec docs) but derived `partial` or
   `failing`: CI fails. Message: "Status declares 'implemented' but N assertion(s)
   fail. Fix the assertions or update the status."

2. Derived `implemented` but declared `proposed`, `accepted`, or `draft`: CI
   fails. Message: "All assertions pass but status declares '{status}'. Promote
   the status to 'implemented' (design) or 'active' (spec), or add a
   `skip_until` suppression if the mismatch is intentional."

3. Derived `partial` or `failing` AND declared `proposed` or `draft`: this is
   the expected state during active development. CI does NOT fail — assertions
   exist but not all pass yet. Only assertion-status contradictions (1 and 2
   above) are failures.

**Rationale for 2:** this is exactly the check that catches case 3
(`cross-app-assertion-grant.md`). All routes exist, all assertions pass, but
declared status says "draft". The checker surfaces the contradiction; the author
must either update the status or explain the suppression.

### 3. Three-Tier Enforcement

**Tier 1 — pre-commit (< 1 s, filesystem + ripgrep only, staged files only)**

Checks:
- Frontmatter block parses as valid YAML.
- Required keys present: `status`, and `assertions` if any assertion block
  exists.
- `status` value is in the valid enum for the doc type.
- Every `path` and `file` field in the assertion block exists on disk.
- Every `type` value is one of the six defined types.

Does NOT check: symbol names, route export presence, migration SQL content,
reachability, or derived-vs-declared contradictions.

Bypassable by design (`git commit --no-verify`). **This tier is a latency
optimization, not an enforcement point.** Workers commit directly without running
hooks, so a local hook cannot constrain runner-authored PRs. CI is the
enforcement point.

**Tier 2 — CI (full resolution, runs when the watch set changes)**

Watch set: `docs/design/**` UNION every path referenced in any `path`, `file`,
or `entry` field across all spec and design docs.

Why `UNION` rather than spec-delta-only: drift runs both directions. A feature
can rot — its code surface deleted or renamed — without any change under
`docs/design/`. `worker-mount-isolation.md` illustrates this: the spec never
changed, but the symbol it described was renamed. A spec-delta-only gate would
have correctly skipped every check while the symbol name diverged.

Checks (all six assertion types at full resolution):
- `symbol`: ripgrep for export in the named file.
- `symbol_reachable`: ripgrep for assignment pattern in the named entry file.
- `route`: file exists AND handler export found.
- `migration`: SQL file exists on disk AND (if DATABASE_URL available) migration
  applied in DB.
- `config_key`: ripgrep in named file.
- `test_file`: file exists.
- Derived-vs-declared status contradiction check.

Budget: ~30 s per affected spec, parallelizable. Spec docs that are NOT touched
by the PR and whose `path`/`file` references are not in the changed set are
skipped (delta gate, §4).

**Tier 3 — weekly LLM cron (schedule `ecc45c47`)**

Scope: specs with **zero assertions declared only**. Specs with at least one
assertion (passing or failing) are out of scope for the cron; CI covers them.

Task template: "For spec X, read its Code surface section. Do the listed routes,
symbols, and migrations exist in the current repo? Draft 2–4 YAML assertion
stanzas for manual review and PR."

The cron's purpose is to shrink the `unverified` bucket toward zero over time as
coverage grows. It does not block anything. A zero-assertion spec is not a
failure state — it is uncovered.

### 4. Delta Gate

The CI job reads the last-run commit SHA from a keyed buildd artifact:
`spec-conformance-last-sha` (per-repo, no new DB table). It diffs
`git diff --name-only <last-sha>..HEAD`. If the intersection of changed files
with the watch set is empty, the job exits 0 immediately without dispatching any
checkers.

On completion (pass or fail), the job writes the current HEAD SHA back to the
artifact via `buildd action=create_artifact key=spec-conformance-last-sha`.
Keyed artifact upsert ensures no duplicate rows accumulate.

**Why the watch set must include code-surface paths, not just spec paths:**
The expensive failure mode has no spec delta. A feature ships (`loop-until-verified`
columns land in migration 0091), the spec is never touched, and every week the
cron skips it because `docs/design/loop-until-verified.md` has not changed.
Meanwhile `loopState` remains unassigned in the completion route. A spec-delta
gate would never catch this. Including `apps/web/src/app/api/workers/[id]/route.ts`
in the watch set means any PR touching that file triggers the loop-until-verified
conformance check.

### 5. Migration Path for Existing Specs

As of 2026-07-25 there are approximately 35 files under `docs/design/` and 14
under `docs/specs/`. Zero have assertion frontmatter.

**Backfill order:**
1. Specs with declared `implemented` or `active` that the recon found have all
   routes and migrations present — these are the highest-value candidates because
   they will flip from `unverified` to `implemented` on first assertion pass.
2. Specs whose code surface lists a route handler — `route` assertions are the
   cheapest to write and the most reliable (file path is unambiguous).
3. Specs that reference a specific migration — `migration` assertions are nearly
   free to write.
4. `symbol_reachable` assertions last — they require understanding the call graph
   and are the most likely to need `skip_until` on first filing.

**Who writes assertions:** the author of any PR that touches a spec file is
expected to add or update assertions for that spec. There is no deadline for
backfilling unmodified specs — they stay in the LLM cron bucket until touched.

**Zero assertions ≠ failure.** A spec with no assertions is `unverified`.
It does not fail CI, does not block merges, and appears in the cron's workload.
The system degrades gracefully: more coverage → more CI enforcement → smaller
cron footprint.

### 6. Escape Hatch

Following the `BUILDD_DISABLE_SANDBOX` precedent
(`apps/runner/src/bwrap-mount-allowlist.ts:39`), an assertion that is temporarily
wrong must be suppressible with a recorded reason rather than forcing deletion.

```yaml
assertions:
  - type: symbol
    name: buildWorkerMountAllowlist
    path: apps/runner/src/workers.ts
    skip_until: "2026-08-15"
    skip_reason: "Renamed to buildWorkerBwrapArgv in bwrap-mount-allowlist.ts — PR updating assertion pending"
```

Rules:
- `skip_reason` is required when `skip_until` is set. A suppression without a
  reason is a CI error.
- `skip_until` must be a future ISO 8601 date at suppression time. An expired
  `skip_until` is treated as if the suppression were absent — the assertion runs.
- A suppressed assertion counts as `partial` for derived-status purposes, not
  `pass`. A spec where every assertion is suppressed has derived status
  `unverified`, not `implemented`.
- CI logs all active suppressions with their expiry dates so they are visible
  in the PR check output.

---

## Worked Examples

These are the three cases from the Problem statement, with literal
copy-pasteable frontmatter. The checker implementation is not part of this
design doc; these stanzas demonstrate what the vocabulary must express.

### Case 1: `worker-mount-isolation.md` — naming divergence

**What happened:** the spec proposed `buildWorkerMountAllowlist` as the function
name. The implementation shipped as `buildWorkerBwrapArgv` in a new file
`bwrap-mount-allowlist.ts`, imported and called from `workers.ts:2098`. The
design doc's status remained "Proposed".

**Frontmatter that would have been filed when the spec was written** (using the
spec's proposed naming):

```yaml
---
status: proposed
assertions:
  - type: symbol
    name: buildWorkerMountAllowlist
    path: apps/runner/src/workers.ts
  - type: config_key
    key: BUILDD_DISABLE_SANDBOX
    file: apps/runner/src/workers.ts
  - type: test_file
    path: apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
---
```

**What would have failed on the implementing PR:**

The PR adds `bwrap-mount-allowlist.ts` (containing `buildWorkerBwrapArgv`) and
updates `workers.ts` to import and call it. The watch set includes
`apps/runner/src/workers.ts`. CI runs. The assertion
`{type: symbol, name: buildWorkerMountAllowlist, path: apps/runner/src/workers.ts}`
finds no match — the symbol was renamed and moved. CI fails with:

> `worker-mount-isolation.md` assertion failed: symbol `buildWorkerMountAllowlist`
> not found in `apps/runner/src/workers.ts`. The symbol may have been renamed
> or moved. Update the spec frontmatter to reflect the new name, or add a
> `skip_until` suppression.

The author — who knows the new name is `buildWorkerBwrapArgv` in
`bwrap-mount-allowlist.ts` — updates the frontmatter before merge:

```yaml
---
status: implemented
assertions:
  - type: symbol
    name: buildWorkerBwrapArgv
    path: apps/runner/src/bwrap-mount-allowlist.ts
  - type: symbol_reachable
    symbol: buildWorkerBwrapArgv
    entry: apps/runner/src/workers.ts
  - type: config_key
    key: BUILDD_DISABLE_SANDBOX
    file: apps/runner/src/bwrap-mount-allowlist.ts
  - type: test_file
    path: apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts
---
```

All assertions now pass, derived status is `implemented`, declared status is
`implemented` — no contradiction.

---

### Case 2: `loop-until-verified.md` — silent no-op

**What happened:** migration 0091 deployed `loop_config`, `loop_iteration`, and
`loop_state` columns. `parseLoopConfig` exists in `packages/core/loop-config.ts`
and is called from task creation routes. But at the time the columns landed,
the worker completion route (`POST /api/workers/[id]`) did not evaluate the loop
condition — the data model was wired but the evaluator was absent. A
"symbol exists" check on `parseLoopConfig` would have reported the spec as
conformant while the feature was a silent no-op.

**Frontmatter that, if added when migration 0091 was filed, would have caught
the partial state:**

```yaml
---
status: proposed
assertions:
  - type: migration
    number: 91
    contains: loop_config
  - type: symbol
    name: parseLoopConfig
    path: packages/core/loop-config.ts
  - type: symbol_reachable
    symbol: loopState
    entry: apps/web/src/app/api/workers/[id]/route.ts
    as: assign
  - type: route
    method: PATCH
    path: /api/workers/[id]
    file: apps/web/src/app/api/workers/[id]/route.ts
---
```

After migration 0091 lands:
- Assertion 1 passes (SQL file exists, contains `loop_config`).
- Assertion 2 passes (`parseLoopConfig` is exported from `loop-config.ts`).
- Assertion 3 **fails** — `loopState` is not assigned in the completion route.
- Assertion 4 passes (route file exists, exports `PATCH`).

Derived status: `partial`. Declared status: `proposed`. No contradiction (partial
+ proposed is the expected in-progress state). CI does not fail — but the partial
result is visible in the check output, signalling that the loop is not yet live.

When the evaluator is later added to the completion route (setting
`taskUpdate.loopState = 'condition_unmet'` etc.), assertion 3 passes. Derived
status becomes `implemented`. Declared status is still `proposed` — now there IS
a contradiction. CI fails until the author promotes the status to `implemented`.

**Why `symbol_reachable` with `as: assign` is necessary here:** if the assertion
were only `type: symbol, name: parseLoopConfig`, it would pass from the moment
`loop-config.ts` was created — well before the completion route evaluated
anything. The `symbol_reachable` check targets the entry point that must do the
work (`route.ts`), not the utility function that can exist without being called
from the critical path.

---

### Case 3: `cross-app-assertion-grant.md` — shipped while draft

**What happened:** the design declares "Status: draft — awaiting approval."
Migration 0079 (`0079_flat_doctor_strange.sql`) applied `assertion_audience` and
`assertion_token_endpoint` columns. `GET /api/.well-known/jwks.json`,
`POST /api/connectors/[id]/assertion`, and `GET /api/cron/jwks-rotation` are all
deployed. The status was never updated.

**Frontmatter that surfaces the contradiction:**

```yaml
---
status: draft
assertions:
  - type: route
    method: GET
    path: /api/.well-known/jwks.json
    file: apps/web/src/app/api/.well-known/jwks.json/route.ts
  - type: route
    method: POST
    path: /api/connectors/[id]/assertion
    file: apps/web/src/app/api/connectors/[id]/assertion/route.ts
  - type: route
    method: GET
    path: /api/cron/jwks-rotation
    file: apps/web/src/app/api/cron/jwks-rotation/route.ts
  - type: migration
    number: 79
    contains: assertion_audience
---
```

All four assertions pass (all routes exist, migration 0079 applied). Derived
status: `implemented`. Declared status: `draft`. CI fails with:

> `cross-app-assertion-grant.md`: derived status is `implemented` (4/4
> assertions pass) but declared status is `draft`. Promote status to
> `implemented` or add a `skip_until` suppression with a reason.

The author updates `status: draft` to `status: implemented`. No other change
needed — all assertions already pass.

---

## Open Questions

**Q: Should design docs and spec docs share a single status enum, or keep
separate enums?**
Design docs use `proposed | accepted | implemented | superseded`. Spec docs use
`draft | active | superseded`. The derived-vs-declared check needs to know which
"all assertions pass" value to compare against (`implemented` vs `active`).
Leaning toward keeping them separate, with the checker inferring doc type from
directory (`docs/design/` vs `docs/specs/`). Unifying would require editing
`docs/specs/SPEC-FORMAT.md` and `docs/design/DESIGN-FORMAT.md`, which is scope
creep for this design.

**Q: Does `symbol_reachable` with `as: assign` require static analysis or is
ripgrep sufficient?**
Ripgrep for `symbol\s*=` in the entry file covers the straightforward case
(direct assignment in the route handler body). It misses indirect paths (symbol
assigned inside an imported helper). Leaning toward ripgrep-only for the initial
implementation: it is fast, dependency-free, and catches the primary case.
Indirect paths require a more expensive approach (TypeScript compiler API or
import graph traversal) that belongs in a follow-on design once the basic
vocabulary is validated in practice.

---

## Non-Goals

- **Checker implementation.** The linter, hook, and CI job are follow-on tasks
  gated on approval of this design.
- **Backfilling any spec's frontmatter.** Also a follow-on task.
- **Hook installation or CI wiring.** Configuration comes after the vocabulary
  is approved.
- **Replacing `spec_compare`.** It serves a different purpose (similarity
  retrieval). It is not deprecated by this design.
- **Expressing test coverage depth.** The `test_file` assertion proves a test
  file exists; it does not count passing assertions, measure branch coverage, or
  validate test quality.
- **Full static analysis / import-graph traversal for `symbol_reachable`.**
  Ripgrep-based approximation is in scope; compiler-API reachability is not.
- **Enforcing spec freshness dates.** The `last_verified` field in spec
  frontmatter is already handled by `scripts/check-specs.ts`; this design does
  not change that.
- **Third-party or generated documentation.** Assertions target the source tree
  of this repo only.
