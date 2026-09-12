---
status: proposed
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "evaluate-spec-documents"
    type: "symbol"
    name: "evaluateAllDocs"
    path: "packages/core/spec-conformance.ts"
  - id: "discrepancy-ledger-table"
    type: "symbol"
    name: "specDiscrepancies"
    path: "packages/core/db/schema.ts"
  - id: "checker-regression-tests"
    type: "test_file"
    path: "packages/core/__tests__/spec-conformance.test.ts"
  - id: "delta-gate-tests"
    type: "test_file"
    path: "scripts/spec-conformance-delta-gate.test.ts"
  - id: "promote-discrepancy-action"
    type: "symbol_reachable"
    symbol: "promote_discrepancy"
    entry: "packages/core/mcp-tools.ts"
    as: "read"
---
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
- `docs/design/task-subject-anchors.md` — prior art: durable identity via `subjectAnchor` +
  `task_subject_claims` atomic-claim table; the discrepancy ledger's identity scheme follows
  this precedent rather than inventing a third one
- `docs/design/friction-dedup-serialization.md` — prior art: durable identity via
  `frictionSignature`; the ledger's "warn, do not block" intake rule follows the same
  reflexive-bypass lesson this doc already paid for
- `packages/core/subject-anchor-extractor.ts`, `apps/web/src/app/api/tasks/route.ts` — the
  exact intake shape (`extractSubjectAnchor()` + atomic dedupe before the row exists) the
  discrepancy intake check reuses
- `apps/web/src/lib/action-queue.ts` — the existing "waiting-on-you" queue (`ActionChip`,
  `buildActionQueue`, `buildDecideItems`) the discrepancy queue extends; also prior art for
  a bounded, ranked, structurally-keyed (never LLM-text-keyed) dedupe fingerprint
  (`criteriaRearmFingerprint`)
- `packages/core/mission-helpers.ts` (`validateGoalCriteria`) — prior art for mechanical,
  command-exit-code closure that this design's row-closure rule aligns its wording with
- `apps/runner/src/prompt-builder.ts` (`buildPromptWithComposition`) — the existing prompt
  assembly point the dispatch-time injection (§11) adds one more block to

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

### 7. The Discrepancy Ledger

Sections 1–6 compute a status. They do not give a mismatch an identity, so a
finding cannot persist between runs — it is a line in a report, redrawn from
scratch every time the checker runs. The weekly drift check has already lived
this failure: `path-claims.md` was reported DRIFTED on 2026-08-25 and again on
2026-08-31, the second time annotated "carried from 2026-08-25, not updated."
Same finding, twice, with no state in between and no record of what, if
anything, anyone did about it.

**A discrepancy is a row, not a report line.** Spec text and assertion
frontmatter stay exactly as designed above — markdown, versioned with the code
they describe. Only the *derived gap* between a declared claim and its
checked reality becomes persistent state, in a new table:

```text
spec_discrepancies
  id                  uuid, pk
  workspace_id        fk -> workspaces
  spec_path           text   -- e.g. docs/design/worker-mount-isolation.md
  assertion_id        text   -- see "Assertion identity" below
  direction           spec_ahead | code_ahead | contradicted   -- §8
  status              open | accepted | resolved               -- §9
  first_seen_at       timestamptz
  last_checked_at     timestamptz
  accepted_reason     text, nullable  -- required when status = accepted
  promoted_mission_id fk -> missions, nullable
  evidence            jsonb   -- the exact read that produced the current verdict
  UNIQUE (workspace_id, spec_path, assertion_id)
```

**Assertion identity.** Every assertion in the frontmatter vocabulary (§1) gets
a new required field, `id`:

```yaml
assertions:
  - id: mount-symbol
    type: symbol
    name: buildWorkerBwrapArgv
    path: apps/runner/src/bwrap-mount-allowlist.ts
```

`id` is author-chosen, kebab-case, and stable across rewordings, renames, and
which model last touched the doc — it identifies the *claim*, not its current
phrasing. This is a deliberate choice against fuzzy or LLM-based matching: a
matcher that re-decides "is this the same finding as last week?" by comparing
prose will answer differently run to run, and a ledger whose rows can silently
merge or split under it is a ledger nobody trusts. `(workspace_id, spec_path,
assertion_id)` is exact and mirrors two precedents already shipped in this
repo — `task_subject_claims`' `UNIQUE (workspace_id, key_type, key_hash)` for
tasks, and the action queue's `criteriaRearmFingerprint`, which is deliberately
a structured fingerprint rather than the LLM-graded failure text itself,
because "the same failure phrases it differently every run" (see
`action-queue.ts`'s comment on that field). Discrepancy identity follows the
same rule for the same reason.

The checker upserts with `INSERT ... ON CONFLICT (workspace_id, spec_path,
assertion_id) DO UPDATE` on every Tier-2 CI run. Unlike `task_subject_claims`,
no optimistic-lock `generation` column is needed: the delta gate (§4) already
serializes runs through the single keyed `spec-conformance-last-sha` artifact,
so there is never more than one writer racing on the same row.

An assertion without an `id` fails Tier-1 pre-commit validation the same way a
missing `path` does today — this is additive to the existing "every `path` and
`file` field exists on disk" check, not a new tier.

### 8. Direction — the Field That Makes Promotion Safe

Every row carries which way the gap runs, and — this is the load-bearing part
— **which tier is allowed to write which direction**, because the tiers differ
in how much evidence backs a verdict.

- **`code_ahead`** — the assertion **passes** but the declared status is
  non-terminal (`proposed`/`accepted`/`draft` — the same set §2's CI failure
  condition 2 already treats as "not yet promoted"). The code demonstrably
  exists; the status string is what's wrong. A doc fix, not a build. Either
  tier may write this — passing evidence needs no judgment call.
- **`contradicted`** — the assertion **fails** but the declared status is
  terminal (`implemented`/`active`) — i.e. exactly the Tier-2 CI failure
  condition 1 in §2. This is deliberately NOT auto-classified as `spec_ahead`:
  a single ripgrep-based assertion failing is exactly the signal that misled
  the 2026-07-25 sweep on `worker-mount-isolation.md` — the symbol had moved,
  not vanished. Tier 2 CI may only ever write `contradicted` here; it does not
  have the search depth (alternate naming, mission/PR/migration search — the
  weekly check's five-step protocol) to tell "renamed" from "never built."
- **`spec_ahead`** — real unbuilt work: the spec's claim does not resolve
  *and* the deeper search has already ruled out a rename or move. Only the
  Tier-3 weekly cron — which already runs the five-step protocol before it is
  allowed to say NOT-BUILT — may write this direction. CI never writes
  `spec_ahead` directly; a CI-tier failure always lands as `contradicted`
  first, and the cron either confirms it into `spec_ahead` or resolves it (the
  symbol was found under alternate naming, so the row is fixed by updating the
  assertion, not by promoting it).
- **A row with no assertion result of any kind is not a row.** Zero-assertion
  specs stay `unverified` (§1 table) and never enter this table at all — see
  §16 on why that must still be visible.

**The promotion rule**, stated so `promote_discrepancy` (§13) can enforce it
mechanically rather than by convention:

| Direction | May `promote_discrepancy` mint a mission? |
|---|---|
| `spec_ahead` | Yes — the only direction promotable without further human adjudication, and only once it carries the cron's confirmation (not a bare CI `contradicted` reclassified in place). |
| `code_ahead` | **Never.** Promoting a doc-drift row into a build mission is precisely how the 2026-07-25 incident happened — the sweep found no unbuilt work and still generated a rebuild recommendation. The only valid actions on a `code_ahead` row are `accept` or a docs-only follow-up task. |
| `contradicted` | Not until adjudicated. `promote_discrepancy` on a `contradicted` row is rejected; `adjudicate_discrepancy` must first flip it to `spec_ahead` or `code_ahead`. |

### 9. Closure Is Mechanical

A row's `status` moves `open` → `resolved` only when a **re-run of the
checker** resolves its assertion — never because an agent, a PR description, or
a task summary asserts completion. This is the same principle mission
`goalCriteria` already enforces for its `command` type: the check's own exit
code is the verdict, not a self-report (`validateGoalCriteria` in
`mission-helpers.ts`). Concretely:

- `spec_ahead` resolves when the assertion passes on a subsequent run.
- `code_ahead` resolves when the declared status is edited to a terminal value
  and the (already-passing) assertion is re-confirmed on the next run.
- `contradicted` resolves once re-evaluation lands cleanly on pass+terminal or
  fail+non-terminal — i.e. it stops contradicting, whether because someone
  built the feature, fixed the frontmatter, or corrected the status string.

`status: accepted` (via `adjudicate_discrepancy`, §13) is a parked state, not a
closed one — an accepted row is still re-evaluated on every run and still
auto-resolves the moment its assertion result would justify it. Accepting a
row records "we know about this and are deferring it," not "this is fine
forever."

### 10. Intake Check

`POST /api/tasks` already runs `extractSubjectAnchor()` and an atomic dedupe
against `task_subject_claims` before the task row is created (see
`apps/web/src/app/api/tasks/route.ts`). The discrepancy intake check is the
same shape, at the same point: after subject-anchor extraction, before the
task is created, match the incoming task's `pathManifest` (when supplied) and
description against **open, `code_ahead`** rows for the workspace.

Matching here is explicitly **not** identity — the ledger row's own identity
stays exact (§7) — it is retrieval, reusing `spec_compare`'s existing
similarity search over the same `{workspaceId}:docs` / `{workspaceId}:code`
corpora, because "does this new task touch a spec area with a known stale
status" is inherently a fuzzy question and pretending otherwise would just
move the false-positive risk into the intake path instead of removing it.

**Warn, do not hard-block.** A match is returned in the `POST /api/tasks`
response body (e.g. `specWarnings: [{specPath, assertionId, direction,
message}]`) and the task is created regardless — there is no `fileAnywayReason`
because nothing is being blocked. This is a deliberate divergence from
`task_subject_claims`' dedupe, which *does* block and *does* need the escape
hatch: subject-anchor dedupe is preventing the same PR/error from spawning two
tasks, a narrow and usually-correct match. Spec-area retrieval is much
broader — many legitimate tasks touch a spec area no assertion happens to
cover — and a blocking check that is wrong often gets bypassed reflexively via
`fileAnywayReason`, which was the exact failure this repo's own friction-dedupe
work already learned from. A routinely-bypassed gate enforces nothing; a
warning that is sometimes irrelevant still costs nothing to ignore.

### 11. Prompt Injection at Dispatch

`apps/runner/src/prompt-builder.ts`'s `buildPromptWithComposition` already
assembles the worker's prompt from role, skills, and CLAUDE.md, with several
conditionally-included blocks (`## Workspace Instructions`, `## Git
Workflow`). Add one more: for a dispatched task whose `pathManifest` intersects
any `path`/`file`/`entry` field named by an **open** ledger row in this
workspace, inject

```
## Spec Discrepancies You May Be Closing
- docs/design/worker-mount-isolation.md — assertion `mount-symbol` (spec_ahead):
  expects `buildWorkerMountAllowlist` at apps/runner/src/workers.ts. If you are
  renaming or moving this symbol, update the assertion frontmatter in the same
  PR — do not leave it pointing at code that no longer exists.
```

This reads from the ledger's already-computed open rows — it does not re-run
the checker at dispatch time, so it costs nothing beyond one indexed lookup per
claim. It is sourced, not re-derived, for the same reason `resolveSessionModel`
reads a precomputed `task.context.model` instead of recomputing routing at
dispatch: the expensive decision was already made once, upstream.

This closes the loop on the spec's own Case 1: the worker who eventually
renamed `buildWorkerMountAllowlist` to `buildWorkerBwrapArgv` discovered the
mismatch only when Tier-2 CI failed after the PR was already written. With
this injection, the worker opens the task already knowing the exact claim
(`mount-symbol`, expecting that name, at that path) it is expected to either
satisfy or update — it can amend the frontmatter in the same commit as the
rename instead of in a second commit reacting to a red check.

### 12. Surface

Open discrepancies belong in the existing waiting-on-you queue
(`apps/web/src/lib/action-queue.ts`), not a new tab — the same queue that
already carries `MERGE`, `REVIEW`, `QUESTION`, and `DECIDE` chips. Add:

- A new raw-item kind, `'discrepancy'`, alongside the existing `merge` /
  `approve` / `answer` / `reconnect` / `decide` kinds in
  `WaitingOnYouRawItem`, carrying `{specPath, assertionId, direction, claim,
  firstSeenAt, promotedMissionId}`.
- A new chip, `DISCREPANCY`, inserted into `CHIP_ORDER` immediately after
  `DECIDE` — same tier as `DECIDE` ("the platform found something that needs
  an owner call," not "a live worker is blocked"), but never above it.
- Subject key `discrepancy:${specPath}:${assertionId}` — identical to the
  ledger row's own identity (§7), following the file's existing convention
  that a chip's dedupe key IS its subject's identity key (compare
  `decide:${missionId}:${criteriaFingerprint}`).
- Row actions: **promote** (`promote_discrepancy`, §13, direction-gated per
  §8), **accept** (`adjudicate_discrepancy` with a required reason), **flip
  direction** (`adjudicate_discrepancy`, for the `contradicted` case). A row
  with a `promotedMissionId` shows the link instead of the promote action.

**The list must be bounded, ranked, and stale rows must expire — this is not
optional.** The Schedules page is the in-house cautionary tale: 48 rows, 87%
pure machinery, so nobody read it and a heartbeat ran 192 times on a finished
mission with nobody noticing. An unbounded machine-generated list is not a
feature; it is the exact hiding place the discrepancy ledger exists to empty
out. Concretely:

- Cap the queue to the top **10** `DISCREPANCY` rows per workspace, ranked
  `contradicted` first (needs an owner call before anything else can happen to
  the row), then `spec_ahead`, then `code_ahead` last (lowest stakes — pure
  doc fix); within a direction, oldest `first_seen_at` first, so a row that
  has already survived three check-runs (the `path-claims.md` problem) always
  outranks one that appeared this week.
- Overflow past the cap is never silently dropped: emit a workspace-level
  count (the `DISCREPANCY`-queue equivalent of `summariseActionQueueAge`) —
  "N discrepancies beyond the visible top 10" — so a clean-looking queue of 10
  cannot hide a growing backlog the way the Schedules page did.
- `status: accepted` rows are excluded from the queue outright — accepting is
  the action that records an owner already made the call; re-surfacing it
  would just be the Schedules page's problem again. They remain queryable via
  `list_discrepancies` (§13) for anyone auditing what's been deferred.
- An `open` row does **not** expire or silently disappear past any age
  threshold. Age is exactly the signal a human should see (per the ranking
  above), not a reason to hide the row — that is the opposite failure from the
  one this section is guarding against.

### 13. MCP Surface

- `list_discrepancies({ workspaceId?, direction?, status? })` — filtered row
  list.
- `get_discrepancy({ discrepancyId })` — returns the evidence read that
  produced the current verdict (the file/symbol/route/migration actually
  checked, and whether it passed) — never a similarity score. `spec_compare`
  already covers "how related is this text"; this tool answers "what did the
  checker actually read, and what did it find."
- `adjudicate_discrepancy({ discrepancyId, action: 'accept' | 'flip_direction',
  reason, newDirection? })` — `accept` requires `reason` (non-blank, same
  discipline as the assertion escape hatch's `skip_reason`); `flip_direction`
  requires `newDirection` and is the only path off `contradicted`.
- `promote_discrepancy({ discrepancyId })` — validates direction per the §8
  table, then mints a mission through the existing `manage_missions`
  create path (same primitive every other mission-creating caller uses) and
  writes `promoted_mission_id` back onto the row. The organizer decomposes the
  resulting mission into tasks exactly as it does for any other mission — see
  §15.
- `spec_compare` is unchanged — it remains the exploration/retrieval tool, and
  is what the intake check (§10) reuses for matching.

### 14. Workspace Portability

Nothing about symbol/route/migration resolution is buildd-specific: the
checker resolves claims against whatever repository a workspace owns via
`workspaces.repoUrl` (`packages/core/db/schema.ts:1790`) — that anchor already
exists and needs no new work. What is currently buildd-hardcoded, and must be
parameterized before another workspace gets this for free:

1. **The weekly Tier-3 cron is a single hardcoded schedule row** (`ecc45c47`)
   that exists only in the buildd workspace. Fix: creating the Tier-3 cron
   becomes a workspace-onboarding step (`create_schedule`), one row per
   workspace that opts in — never a single ID referenced by name.
2. **The watch-set roots `docs/design/**` and `docs/specs/**`** are this
   repo's own documentation layout convention (see this file's own CLAUDE.md
   "Specs & Docs Layout" section), not a universal one. Fix: a per-workspace
   `specsRoot` / `designRoot` config, naturally alongside the existing
   per-workspace `watchedProjects` row (`manage_watched_projects`,
   `packages/core/db/schema.ts:1726`, which already scopes `repo`, `roleSlug`,
   and notes per project). Default to buildd's own paths only for the buildd
   workspace.
3. **The delta gate's keyed artifact, `spec-conformance-last-sha`**, must stay
   workspace-scoped (it already is "per-repo" per §4's original design;
   `create_artifact`'s workspace scoping gives this for free) — stated
   explicitly here so two workspaces running Tier 2 concurrently never read or
   overwrite each other's last-checked SHA.
4. **`spec_discrepancies` is already workspace-scoped** (§7's schema) — no
   additional work needed there; called out so a reader doesn't assume
   otherwise.

A new workspace gets machine-checkable spec conformance by: adopting
SPEC-FORMAT.md-style frontmatter (or an equivalent) in its own `docs/`,
setting its `specsRoot`/`designRoot`, and opting into the Tier-3 cron via
`create_schedule`. No buildd-specific code changes for a new workspace to use
this — only configuration. This is the difference between an internal
convenience and a reason to run a codebase through buildd at all.

### 15. Ownership: No New Agent Role

The two enforcement points added in this revision — the intake check (§10) and
the dispatch injection (§11) — are both existing mechanical, route-level code
paths, not agent-authored prompts. This is a deliberate choice, not an
omission: agent behaviour in this repo currently lives across three layers
that must be kept in sync by hand — role system prompts, skill bodies, and
CLAUDE.md — and PR #2050 needed to update all three together for a single
behaviour change to land coherently. A prompt instruction telling an agent "go
check whether a discrepancy applies" is weaker enforcement than a route-level
check for exactly that reason: it silently stops firing the moment any one of
those three layers drifts, and nothing signals that it has. A route-level
check has one place to update and cannot be skipped by a role, skill, or
CLAUDE.md revision falling out of sync.

The organizer is unchanged. `promote_discrepancy` mints a mission through the
same `manage_missions` create path any other caller uses, so the organizer
keeps decomposing a promoted discrepancy into tasks exactly as it does for any
other mission today — no new role, no special-cased "discrepancy work" agent.

### 16. Costs, Stated Honestly

- **Authoring burden.** Every assertion now needs an `id` in addition to a
  checkable symbol/path — `docs/specs/SPEC-FORMAT.md` already found six
  claimed symbols across four *active* specs that named nothing real. The
  ledger inherits that same risk one level down: a badly-named symbol produces
  a bogus `spec_ahead` row, not just a spec sitting at `unverified`.
- **Zero-assertion specs produce no ledger row at all** — there is nothing to
  check, so nothing can be flagged as a discrepancy. `unverified` must stay
  **visible** anyway, or this reproduces the exact hole that let
  `spec-conformance.md` itself sit exempt from its own drift check for over a
  month (see below). An empty `DISCREPANCY` queue must never be read as "spec
  conformance is fine" — it can just as easily mean "nothing has assertions
  yet." The Tier-3 cron's per-run zero-assertion count (already produced today
  — every recalled weekly-check outcome lists an UNVERIFIED section) is the
  visibility mechanism; the ledger does not replace it, and must not be
  presented as if it did.
- **Resolving this doc's own exemption.** The weekly drift-check task template
  has, on three runs (2026-08-10, 2026-08-17, 2026-08-31), special-cased
  `spec-conformance.md` and `cloudflare-sandbox-runner.md` as exempt "by
  design," separately from the ordinary `unverified` bucket every other
  zero-assertion spec falls into. That special case was papering over "the
  thing that would make this checkable does not exist yet" as though it were
  an intentional, permanent design decision — it is neither. This doc has zero
  assertions today, so its honest verdict is `unverified`, exactly like any
  other zero-assertion spec — not a separate "by design" skip. The exemption
  ends, not is resolved by fiat: once Implementation Slice 1 (below) ships and
  this doc carries real assertions against its own checker/table/schema, the
  next weekly-drift-check task template must drop this filename from any
  exemption note and sweep it like every other design doc. Until then, the
  correct instruction to future drift-check runs is simply: do not special-
  case this file: report it `unverified` and move on, the same as any spec
  with no assertions yet.

---

## Implementation Slices

Each slice below is sized as one PR, in dependency order. None of this ships
in the current task — this section exists so a follow-on task can be filed
directly against a numbered slice instead of re-deriving scope from the design.

1. **Assertion `id` field + checker core.** The original, still-unbuilt
   checker (§1–§6): the six assertion types gain the required `id` field
   (§7), and a script evaluates assertions and computes derived-vs-declared
   status per §2. No ledger table yet — this slice is a prerequisite for every
   later one, since nothing can be logged as a discrepancy before something
   can evaluate an assertion.
2. **`spec_discrepancies` table + ledger writes from Tier-2 CI.** Migration
   adds the table (§7); the Tier-2 CI job upserts a row per
   `(workspace, specPath, assertionId)` on every run, computing `direction`
   per the §8 rule and `status` transitions per §9. Depends on Slice 1.
3. **MCP surface** — `list_discrepancies`, `get_discrepancy`,
   `adjudicate_discrepancy`, `promote_discrepancy` (§13), reading and writing
   the Slice 2 table. `promote_discrepancy` calls the existing
   `manage_missions` create path. Depends on Slice 2.
4. **Intake check** at `POST /api/tasks` (§10) — warn-only match against open
   `code_ahead` rows via `spec_compare` retrieval. Depends on Slice 2 (rows to
   match against); independent of Slice 3.
5. **Dispatch injection** in `prompt-builder.ts` (§11) — inject open-row
   assertion clauses for a task's `pathManifest`. Depends on Slice 2;
   independent of Slices 3 and 4.
6. **Waiting-on-you surface** — the `DISCREPANCY` chip, bounded/ranked/
   expiring queue behaviour (§12). UI actions (promote/accept/flip) call the
   Slice 3 MCP-equivalent routes, so there is one mutation path regardless of
   whether a human clicks a card or an agent calls the MCP tool directly.
   Depends on Slice 3.
7. **Tier-3 weekly cron generalization + workspace portability** (§14) —
   parameterize `specsRoot`/`designRoot`, replace the hardcoded `ecc45c47`
   schedule with a per-workspace `create_schedule` step. Deliberately last: it
   is the generalization step, and only matters once Slices 1–6 are proven on
   the buildd workspace itself.

**The missing-assertions gate is not its own numbered slice either.** Once Slice
1 shipped, the corpus sat at 108 of 110 docs `unverified` with nothing pushing
back: §2's contradiction checks only ever compare a declared status against a
*derived* one, and a doc with zero assertions derives `unverified` — which both
CI failure conditions in §2 explicitly exempt. A doc could therefore declare
`implemented` (design) or `active` (spec) — the terminal, "this describes
reality" claim — while carrying a frontmatter block that had never been asked
to prove anything, and nothing said so. `checkMissingAssertions` in
`packages/core/spec-conformance.ts` closes that gap: a terminal-status doc with
zero declared assertions (presence, not passing-ness — an assertion under an
active §6 suppression still counts) is now a CI failure, with the same shape of
escape hatch mission `goalCriteria` already uses for its prose-graded
`description` type (`validateGoalCriteria` in `mission-helpers.ts`) — a
`not_mechanizable_reason` frontmatter field, 10+ characters, for a doc whose
claims genuinely cannot be expressed in the six-type vocabulary. Landing the
gate against a 108-doc backlog needed one more thing an outcome-only CI check
doesn't: `MISSING_ASSERTIONS_DEBT`, a grandfather set mirroring
`VERIFIED_BY_DEBT` in `scripts/check-specs.ts` exactly — every doc that violated
the gate the day it shipped is seeded in, so merging it didn't turn every
future PR red; the set only ever shrinks as real assertions land, and a new doc
may never be added to it.

**CI wiring is not its own numbered slice.** Two gaps surfaced only once
Slice 2 was being wired: the Slice-1 checker (`scripts/check-spec-conformance.ts`)
had no GitHub Actions invocation at all, so §3's claim that "CI is the
enforcement point" was untrue in practice; and §4's delta gate — a keyed
buildd artifact recording the last fully-checked commit, used to skip a run
when nothing in the watch set changed — was unimplemented, so every Tier-2
job ran unconditionally. Both landed together, outside the slice numbering
above: a `Spec Conformance Check` workflow runs the Slice-1 checker with
`--fail-on-contradiction` on every PR and on push to `dev`, gated by
`scripts/spec-conformance-delta-gate.ts` (`computeWatchSet`/`isWatched` in
`packages/core/spec-conformance.ts` implement the watch set itself). The
gate's write-back runs only from push-to-`dev`, since a PR's tip is not
generally an ancestor of `dev` and the "last fully-checked commit" pointer
only means something against a single serialized, linear history; the `check`
half is read-only and safe to run from any number of concurrent PR checks
against that same trunk-recorded pointer. Recording the artifact needed a
write path the platform didn't have: every existing artifact-create route
requires an owning mission, initiative, or worker, but this marker must
outlive any of those, so `POST /api/workspaces/[id]/artifacts` (workspace-scoped,
upserting on the existing `(workspaceId, key)` unique index) was added
alongside it.

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

### Case 4: `path-claims.md` — durable identity across reruns

**What happened:** the weekly drift check reported `path-claims.md` as
DRIFTED (declared `Proposed`, code shipped) on 2026-08-25, and again on
2026-08-31 — the second report annotated "carried from 2026-08-25, not
updated." No state existed between the two runs; the second run rediscovered
the same fact from scratch and had no way to know a human had already seen it
once.

**With the ledger:** assume `path-claims.md` carries (per Slice 1)

```yaml
assertions:
  - id: path-claims-table
    type: symbol
    name: pathClaims
    path: packages/core/db/schema.ts
  - id: path-claims-route
    type: route
    method: POST
    path: /api/path-claims
    file: apps/web/src/app/api/path-claims/route.ts
```

On 2026-08-25, Tier-2 CI evaluates both assertions: both pass, declared status
is `Proposed` (non-terminal) → `direction: code_ahead`. The checker upserts
`(workspace, docs/design/path-claims.md, path-claims-table)` and
`(..., path-claims-route)` as `status: open`, `first_seen_at: 2026-08-25`.

On 2026-08-31, the same evaluation runs again: same result, same direction.
The `ON CONFLICT` upsert updates `last_checked_at` only — `first_seen_at`
stays `2026-08-25`, `status` stays `open`. The row is the *same row*, not a
new report line. Anyone opening `get_discrepancy` sees it has been open for
six days, not "just found."

Two outcomes this makes possible that the report format could not:

- The waiting-on-you queue (§12) ranks this row by its true age — a
  six-day-old `code_ahead` row genuinely does outrank one that appeared
  today, and the ranking can say so because `first_seen_at` is real state, not
  a re-derived guess.
- Once someone runs `adjudicate_discrepancy(accept, reason: "status text
  fix queued")` or a doc-fix PR lands and status is promoted to `Accepted`,
  the row resolves (§9) and never resurfaces — the September re-run of the
  same checker sees passing assertions and a terminal status and writes
  nothing, because there is nothing left to write.

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

- **Checker, ledger, MCP surface, intake, dispatch, and UI implementation.**
  All of it is follow-on work, gated on approval of this design and sequenced
  as the seven numbered slices in **Implementation Slices** above — file
  against a slice number, not against this document as a whole.
- **Backfilling any spec's frontmatter.** Also a follow-on task, per the
  Migration Path (§5) backfill order.
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
