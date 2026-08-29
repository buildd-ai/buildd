# Deliverable Uniqueness: Authoring-Time Prevention of Duplicate Artifacts

**Status:** Proposed  
**Related:**  
- `docs/design/friction-dedup-serialization.md` — shipped friction dedup by `(frictionSignature, workspaceId)`, §3 overlap-aware branching (prior art)  
- `docs/design/task-subject-anchors.md` — shipped subject-anchor intake dedupe; `task_subject_claims` atomic claim table is the primitive this doc reuses  
- `docs/design/change-intent.md` — shipped §1–7: `changeIntents` table, sequence-namespace anchor injection, migration-slot reservation  
- `docs/design/path-claims.md` — shipped runtime path-lock primitive (`path_claims` + `path_claim_waiters`); orthogonal to this doc  
- `packages/core/db/schema.ts` — `tasks.pathManifest`, `tasks.subjectAnchor`, `taskSubjectClaims`, `pathClaims`  
- `apps/web/src/app/api/tasks/route.ts` — `POST /api/tasks` intake pipeline  
- `packages/core/path-overlap.ts` — `pathsOverlap`, `findBlockingPr`, `serializeBatchByManifest`

---

## Problem

Two tasks in the same mission both created the `path_claims` table and both generated migration `0114`. Tasks `0b7fcf8c` and `222e9216` each declared the same DB schema symbol; each ran `bun db:generate`; each opened a PR. Migration numbers collided and the second task rebuilt the first task's work.

Neither task was a retry of the other. Their subjects were different: one was "add the path_claims table and update check_path_claim", the other was "add claim lifecycle, release events, and a waiter queue." From the orchestrator's perspective these were sequential phases, but both were filed without an explicit `dependsOn` linking them to each other, so both became claimable at the same time.

The failure mode was not a race at execution time — serialization would have caught that. It was a planning failure at authoring time: the orchestrator filed two tasks that would produce the same artifact without any mechanism to detect the collision before work started.

---

## Mandatory Prior Art Assessment

Three earlier missions shipped dedup machinery that did not prevent this incident. This doc explains what each covers and why a gap remains.

### 1. Friction dedup (`friction-dedup-serialization.md`)

Delivered `(frictionSignature, workspaceId)` dedup at `POST /api/tasks` for `[friction]` tasks, plus `inferFrictionManifest()` and the closed-PR unblocking fix in `deps-gate.ts`. This machinery is scoped to friction tasks by design and does not apply to general deliverable collisions.

### 2. Subject-anchor intake dedupe (`task-subject-anchors.md`)

Delivered `subjectAnchor` extraction, `task_subject_claims` (atomic INSERT…ON CONFLICT table), and the `created`/`attached`/`superseded`/`filed_anyway` outcome taxonomy. The schema confirms these tables are live.

Subject anchors answer: **what is this task acting on?** (a PR, an error, a mission, a branch). The `PrGenerationKey`, `ErrorKey`, and `MissionIntentKey` dedupe types all describe the task's *input*. They cannot catch a deliverable collision because the two tasks in the incident had genuinely different subjects — one acted on "the path_claims schema feature", the other acted on "claim lifecycle and waiter queue." Same mission, different intent descriptions, identical output artifacts.

Extending `task_subject_claims` with a `deliverable` key type (see Proposal §4) reuses the same atomic primitive without conflating input-subject with output-deliverable. These are orthogonal axes.

Note on `7/7: prior-work injection at claim` from mission `ddfcebfe`: whether or not this shipped, it operates at **claim time** — it injects advisory context about prior work for the same subject into the agent's prompt. Advisory injection does not prevent a second task from being filed, does not block it from being claimed, and depends on the agent correctly interpreting the advisory. Authoring-time prevention (this doc) is strictly stronger.

### 3. Change-intent / migration-slot (`change-intent.md`)

Delivered §1–7: `changeIntents` table, sequence-namespace anchor injection (auto-appends `_journal.json` when `pathManifest` overlaps a `sequenceNamespace.dir`), and migration-slot reservation (`POST /api/workspaces/[id]/migration-slot`, backed by atomic `last_migration_number` increment).

Change-intent addresses **ordering and numbering** — it serializes tasks that touch the same sequence namespace and gives each a unique migration number. It does not prevent two tasks from both *creating the same DB table inside schema.ts*. Sequence-namespace injection creates a `dependsOn` edge that says "run B after A." It does not say "B is filing work that A already covers; reject B."

Furthermore, migration-slot reservation requires the agent to call `POST /api/workspaces/[id]/migration-slot` before `bun db:generate`. If the orchestrator files two tasks that each do this independently, each will get a unique number — but each will still create a duplicate table definition. The migration number collision is solved; the symbol-level collision is not.

### The residual gap

No existing mechanism asks: **does any active task already commit to producing this specific named artifact (a DB table, an API route, a config key)?** That is what this doc proposes.

---

## Proposal

### Crux

The crux is the **claim unit**: what granularity makes a deliverable uniquely claimable? The answer is a `(kind, name)` pair where `kind` is a category of output artifact and `name` is its normalized identifier within that category. The wrong choice is: (a) the file path alone — too coarse; `packages/core/db/schema.ts` is modified by nearly every schema task, (b) free-form prose — not matchable, (c) the full PR description — too late (not available at filing).

If the claim unit is wrong, the gate either fires too broadly (blocking legitimate parallel work on the same file) or not at all (missing the exact collision). The `(kind, name)` pair is narrow enough to allow parallel tasks that touch the same file for different reasons, and precise enough to block two tasks that both declare "I will create table `path_claims`."

---

### Q1 — What distinguishes 'creates' from 'modifies' when the artifact is a table added to an existing file?

`packages/core/db/schema.ts` is modified by nearly every schema task. The table added to it is the thing that must be unique. Therefore:

- **`pathManifest`** continues to express file-level modification intent. A task that adds a table to `schema.ts` sets `pathManifest: ["packages/core/db/schema.ts"]`. This drives serialization, `findBlockingPr`, and sequence-namespace injection. No change needed.

- **`deliverableManifest`** (new) expresses symbol-level creation intent. A task that creates the `path_claims` table sets `deliverableManifest: [{ kind: "db_table", name: "path_claims" }]`. This drives the uniqueness check.

The distinction is intentional: a task that modifies an existing table (adds a column) sets `pathManifest` but sets no `deliverableManifest` entry for that table — it is not creating a new artifact, it is modifying one. Only tasks that create a *new named artifact* set a `deliverableManifest` entry.

**Justification against the specific incident**: tasks `0b7fcf8c` and `222e9216` both touched `schema.ts` (file level) but the collision was at the `path_claims` symbol level. A file-level check would block all parallel schema tasks; a symbol-level check would have blocked only the duplicate declaration.

---

### Q2 — Migration files: allocation as a real claim

`change-intent.md` §5 already provides atomic migration-number allocation via `POST /api/workspaces/[id]/migration-slot`. This doc does not reinvent that mechanism. Instead it extends the `deliverableManifest` vocabulary with a `db_migration` kind:

```
{ kind: "db_migration", name: "<formatted-number>" }
```

Agents that call the migration-slot API receive a `formatted` number (e.g. `"0114"`). They then include `{ kind: "db_migration", name: "0114" }` in their `deliverableManifest`. The deliverable uniqueness check at intake catches any second task that tries to claim the same slot, even if they called the migration-slot API from a stale state.

**Allocation timing**: At task-creation, not at first-write. The reason: a claim made at first-write is an execution-time event, not an authoring-time one. The orchestrator knows it intends to create a migration when it files the task. Requiring declaration at creation enables the intake check to fire before any work starts.

**Agents that do not know the migration number at filing time**: They omit `db_migration` from `deliverableManifest` and call the migration-slot API when they actually run `bun db:generate`. This is the current behavior and remains valid. The system is additive: declaring the deliverable enables the check; omitting it falls back to existing ordering machinery.

**What happens when a task is cancelled or its PR closes without merging**: The migration number is **burned**, not released. A gap in migration numbers is acceptable (Drizzle tolerates non-contiguous sequences); a reused number would re-introduce the collision. The `deliverable_claims` row (see §4) transitions to `released` state when the task is cancelled or the worker's PR closes without merging. The `last_migration_number` counter is not decremented — once issued, the slot is consumed regardless of outcome.

---

### Q3 — Enforcement point and failure mode

The deliverable uniqueness check fires at **task creation** (`POST /api/tasks`), in the same pipeline as friction dedup and subject-anchor intake. When a second task files with a `deliverableManifest` entry that collides with an active claim:

- Default response: **409** with body `{ error: "deliverable_claimed", canonicalTaskId: "...", deliverable: { kind, name } }`.
- Override: the caller may pass **`fileAnywayReason`** (existing escape hatch, introduced by subject-anchor intake). A nonblank reason files the task anyway with `subjectDedupeScope: "none"` semantics for this specific claim. The canonical task gets a report noting the override.

**Is a hard 409 safe?** Yes, *when the orchestrator declares a deliverable at filing time*. The precondition is that the orchestrator knows what it intends to create. If it does not know (task description is vague, deliverableManifest is omitted), the check does not fire and there is no false rejection. Hard reject is only triggered by an explicit declaration, which implies the orchestrator already has enough information to make the declaration — and therefore enough information to have detected the conflict itself.

**Why not a warning only?** A warning at task creation would still allow both tasks to run, deferring the conflict to merge time. The incident demonstrates that merge-time detection (change-intent §4 warns at PR creation) is too late: both tasks have already done the work, both PRs are open, and manual triage is needed. The gate must fire before work starts.

**Why not a hard 400 with no escape hatch?** Two tasks filing the same deliverable is a planning mistake in most cases but a legitimate sequencing choice in rare ones (e.g., an explicit redo of a failed PR). The `fileAnywayReason` escape hatch preserves that flexibility without requiring a code change.

---

### Q4 — Backfill and migration path

Every existing task has an undifferentiated `pathManifest` (or none). Many carry the `["**"]` wildcard sentinel.

**Default interpretation of legacy manifests**: `deliverableManifest` is absent → no deliverable claims → no uniqueness checks apply. The new check is purely additive. Legacy tasks cannot retroactively block new tasks from being filed, and new tasks with `deliverableManifest` cannot retroactively claim to conflict with legacy tasks.

**The `["**"]` wildcard sentinel**: This sentinel means "this task may touch any file." It is a pathManifest concept and has no deliverable equivalent. `deliverableManifest` entries are always explicit; there is no wildcard deliverable. Tasks with `["**"]` path manifests continue to interact with `pathsOverlap` exactly as today.

**No bulk backfill**: Do not infer `deliverableManifest` from task descriptions, titles, or PR content for historical tasks. False inferences would block valid active work. Backfill is limited to tasks an operator explicitly annotates via `PATCH /api/tasks/[id]`.

---

### Q5 — Relationship with the runtime primitive (`path_claims`)

`path_claims` (PR #1789) and `deliverableManifest` are orthogonal:

| Dimension | `path_claims` | `deliverableManifest` |
|---|---|---|
| When | Runtime (worker is active) | Authoring time (task is filed) |
| Granularity | File path | Logical artifact (table, route, key) |
| Lifetime | Held while worker active; released on completion | Active while task is pending/assigned/in_progress; released on cancellation or unmerged PR close |
| Purpose | Prevent concurrent file writes | Prevent duplicate artifact production |
| Enforcement | 409 from MCP `check_path_claim` at first write | 409 from `POST /api/tasks` at task filing |
| Failure mode | Worker pauses and waits in `path_claim_waiters` | Task is rejected; orchestrator must merge intent or file anyway |

A `kind` column does not belong on `path_claims`. The runtime lock table tracks *which worker holds a file right now*; it has no semantic knowledge of what the worker intends to create inside that file. Adding kind to a runtime row would couple authoring semantics to runtime state and make release logic conditional on intent — the wrong abstraction.

A `kind` column on the task record is also wrong for the same reason: tasks currently carry pathManifest (file intent) and subjectAnchor (input subject). Adding deliverableManifest as a peer field is consistent. Making it a column on `tasks` itself would be opaque; a JSONB array is the right shape.

**No duplication of `pathsOverlap()` or the `**` sentinel**: `deliverableManifest` checks use exact `(kind, name)` equality, not path prefix matching. `pathsOverlap()` is not called for deliverable checks. The `**` sentinel has no deliverable equivalent (see Q4).

---

## Current State

The pieces that already exist and are reused:

- `task_subject_claims` (`packages/core/db/schema.ts` lines 956–980): partial-unique index `WHERE state = 'active'` on `(workspaceId, keyType, keyHash)`. The atomic INSERT…ON CONFLICT pattern here is the primitive to reuse.
- `fileAnywayReason` escape hatch: accepted at `POST /api/tasks`, sets `subjectDedupeScope = 'none'` on the resulting task.
- `SubjectIntakeOutcome` type in `apps/web/src/app/api/tasks/route.ts`: the `created`/`attached`/`filed_anyway` outcomes already exist for subject anchors; `deliverable_claimed` extends this vocabulary.

---

## Data Model

### New field: `tasks.deliverableManifest`

```typescript
type DeliverableEntry = {
  kind:
    | "db_table"       // a new table in schema.ts; name = table name
    | "db_migration"   // a migration file; name = zero-padded number e.g. "0114"
    | "api_route"      // a new Next.js route; name = route path e.g. "/api/foo/bar"
    | "npm_package"    // a new package in packages/; name = package dir name
    | "schema_type"    // a new exported TypeScript type; name = "PackageName:TypeName"
    | "config_key";    // a workspace config key; name = dot-delimited path
  name: string;        // normalized lowercase; no trailing slash; max 500 chars
};

// Added to tasks table (JSONB, nullable):
deliverableManifest: DeliverableEntry[] | null
```

Normalization rules:
- `name` is trimmed and lowercased before storage and before hash computation.
- `db_table` names strip schema prefix if present (e.g. `"public.path_claims"` → `"path_claims"`).
- `api_route` names normalize to lowercase with no trailing slash and with dynamic segments in brackets (e.g. `"/api/tasks/[id]/path-claim"`).
- Empty `deliverableManifest: []` is stored as `null`.

### Reuse of `task_subject_claims`

Add `key_type = 'deliverable'` as a valid value alongside `'pr_generation'`, `'error'`, and `'mission_intent'`. The claim key hash for a deliverable entry is:

```
sha256(workspaceId + ":" + kind + ":" + normalizedName)
```

No schema migration is needed for `task_subject_claims` itself — `key_type` is already `text`, unconstrained. One deliverable entry = one claim row. A task with three deliverable entries inserts three rows; the first conflict wins.

### Claim state lifecycle

```
'active'   — task is pending, assigned, or in_progress
'released' — task cancelled; or worker PR closed without merging
             (the number/name is burned, not reused)
```

The `releasedAt` timestamp is set by the same webhook and reaper paths that already manage `prLifecycleStatus`.

---

## Implementation Sketch

Ordered by load-bearing priority:

1. **Schema migration**: Add `deliverable_manifest JSONB` column to `tasks`. Add Drizzle migration. No index needed initially — the uniqueness check uses `task_subject_claims`, not a full-table scan.

2. **Intake check in `POST /api/tasks`** (`apps/web/src/app/api/tasks/route.ts`): After subject-anchor intake, before `db.insert(tasks)`. For each entry in `deliverableManifest`:
   - Compute the hash.
   - Attempt `INSERT INTO task_subject_claims (workspaceId, keyType, keyHash, canonicalTaskId, state) VALUES (..., 'deliverable', ..., <new task id>, 'active') ON CONFLICT (workspace_id, key_type, key_hash) WHERE state = 'active' DO NOTHING RETURNING id`.
   - On conflict: read the existing `canonicalTaskId`, return 409 with `{ error: "deliverable_claimed", canonicalTaskId, deliverable }` unless `fileAnywayReason` is set.
   - On `fileAnywayReason`: proceed with task insert; mark the claim row `subject_dedupe_scope = 'none'` on the new task; post a note to the canonical task.

3. **Claim release paths**: Add `'deliverable'` to the `keyType` filter in the existing claim-release logic that fires on task cancellation and PR-close webhooks. The release is a conditional UPDATE on `task_subject_claims` (`state = 'released', released_at = NOW()`) guarded by the task ID to prevent stale releases.

4. **MCP `create_task` handler** (`packages/core/mcp-tools.ts`): Accept and pass through `deliverableManifest`. When the API returns 409 `deliverable_claimed`, format the response as:
   ```
   Deliverable already claimed: <kind> "<name>" is owned by task <canonicalTaskId>.
   Attach to that task or pass fileAnywayReason to override.
   ```

5. **Builder role instructions** (`.claude/skills/buildd-workflow/`): Document `deliverableManifest` with examples for the common kinds. Instruct agents to declare it at task-filing time, not post-hoc.

6. **`PATCH /api/tasks/[id]`**: Allow operators to set `deliverableManifest` on existing pending tasks. Trigger claim insertion for any new entries. Reject entries that would conflict with another task's active claim.

---

## Rejected Alternatives

### Stricter orchestrator prompt

The orchestrator prompt already instructs agents to set `pathManifest` and `dependsOn`. The incident happened anyway. Prompt-level guidance is advisory; an orchestrator that is unsure about what a phase task will produce cannot reliably populate fields it doesn't know it needs. A prompt change would raise the bar marginally; it would not add a blocking gate. The historical record shows three prior missions shipped dedup machinery precisely because prompts alone are not sufficient.

### Per-mission manual review

Adds latency to every multi-phase mission filing. The value proposition of the orchestration system is autonomous agent operation; requiring human sign-off on task plans before any work starts defeats that. Manual review catches planning mistakes only if the reviewer has full context — which an automated intake check has by design.

### Extend subject-anchor deduplication with a 'deliverable' subject kind

Subject anchors describe what a task *acts on* (a PR, an error, a branch, a mission). Deliverables describe what a task *produces*. Conflating them would mean the subject-anchor model answers two unrelated questions. The `task_subject_claims` table *mechanism* is reused (see §4), but the semantics are kept separate. A `deliverable` subject kind would be a misnomer that would confuse future maintainers of the subject-anchor system.

### Fix existing serialization (pathManifest + dependsOn)

Path-level serialization creates `dependsOn` edges that say "do B after A." This is the right fix for *ordering* — it prevents concurrent file writes. It is not a fix for *duplication* — it cannot prevent B from redoing A's work after A completes. Even with perfect `dependsOn` coverage, a second task that runs sequentially after the first can still declare "I will create table X" if it does not notice that A already created X. The deliverable check fires at task-*creation* time regardless of ordering, and fires even when A is already `completed`.

### Rely on path_claims (runtime lock)

Runtime locks catch conflicts at first-write. By then, both tasks have been claimed, branches cut, and work started. The recovery cost is high: the second task discovers the conflict mid-execution, must abort, and the orchestrator must refile. Authoring-time prevention costs nothing when it fires correctly and saves the full execution cost of a duplicate task.

### Do nothing — accept that agents will notice and self-correct

The incident lasted through two PRs both being opened. Agents do not reliably notice that another PR has already created the artifact they are about to create, especially when working on a fresh branch from `dev` with the first PR not yet merged. Self-correction has too many failure modes (wrong PR reviewed, diverged branch, overlapping migrations).

### A third mechanism is not warranted — extend subject-anchor instead

This is the honest question the task asks us to confront. The answer: extending subject anchors with a deliverable key type would be mechanically correct (the `task_subject_claims` table already supports it) but semantically misleading. The right scope boundary is: subject anchors own input-subject dedup; `deliverableManifest` claims own output-artifact dedup. Sharing the *table* and *primitive* while maintaining distinct key types is the right split — neither a pure extension nor genuinely separate machinery.

---

## Open Questions

1. **Should `deliverableManifest` be required for certain task categories?** The `category = 'chore'` and `category = 'feat'` categories both produce schema changes. Requiring `deliverableManifest` for tasks with `pathManifest` overlapping `packages/core/db/` would catch most schema collisions automatically. Risk: false negatives when agents misidentify categories; false positives if the requirement triggers on modification-only tasks. Lean: **optional for now, required only when orchestrator sets a `db_table` deliverable explicitly**. Re-evaluate after measuring actual declaration rates.

2. **How should `deliverableManifest` interact with `outputRequirement`?** Currently `outputRequirement: "pr_required"` or `"artifact_required"` governs what kind of output is produced, not what the output contains. They are orthogonal but a future audit of deliverable coverage could use `outputRequirement` as a signal. No action needed now.

3. **Should released migration numbers be surfaced to agents?** When a task is cancelled after reserving migration `0114`, the number is burned. The next task gets `0115`. This could create visible gaps in the migration log. Whether to document the gap in a comment in the migration file is a style question for the Builder role instructions. Lean: **yes, document the gap** in a `-- reserved by task <id>, cancelled` stub file to aid future debuggers.

4. **Is `schema_type` the right kind for TypeScript types?** TypeScript types are often co-located with their corresponding DB table (e.g., `NewPathClaim` next to `pathClaims`). A `schema_type` deliverable claim would collide if two tasks both create `NewPathClaim`. In practice, if the `db_table` claim fires, the TypeScript type is implicitly blocked too. Consider omitting `schema_type` from the initial kind list and adding it later if observed collisions warrant it. Lean: **defer `schema_type` from the initial implementation**.

---

## Non-Goals

- **Runtime lock behavior**: `path_claims`, `path_claim_waiters`, waiter fan-out, deadlock detection. Those are defined and implemented in `docs/design/path-claims.md`.
- **Worker-to-worker messaging**: defined in `docs/design/path-claims.md` §3.
- **The prose-gate lint** (sibling task `8b54f1bf`): prose-level validation of task descriptions. Separate concern.
- **Mission-completion gating** (sibling task `14d11a49`).
- **Retroactive dedup of existing collisions**: the two PRs from the incident are already open; this doc addresses prevention of future collisions.
- **Detecting modification-only conflicts**: two tasks that both *modify* (not create) the same table column. Those are serialized by `pathManifest` overlap and `dependsOn` edges. Deliverable claims apply only to creation, not modification.
- **Cross-workspace uniqueness**: deliverable claims are scoped to `workspaceId`. Two workspaces can each create a table with the same name.
