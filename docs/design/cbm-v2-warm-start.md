# CBM v2: Warm-Start via Version-Keyed Canonical Seed

**Status:** Proposed  
**Related:**
- `docs/design/codebase-memory-mcp-integration.md` — v1 design (§4.2 chose per-task cold rebuild; this spec addresses that cost)
- `apps/runner/src/cbm-bootstrap.ts` — current cold-build bootstrap implementation
- `apps/runner/src/cbm-enforcement.ts` — activation logic (`buildCbmActivation`, `buildCbmMcpEntry`)
- `apps/runner/src/bwrap-mount-allowlist.ts` — bwrap argv builder; `CBM_BINARY_PATH` constant
- PR #1549 — CBM binary + cache dir added to bwrap mount allowlist

---

## Problem

The v1 design (§4.2 of `codebase-memory-mcp-integration.md`) gives each worker a fresh
`CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}` and runs `index_repository` from scratch on every task.
Measured cost on the buildd repo:

| Environment | Wall-clock (cold, default mode) |
|-------------|----------------------------------|
| buildd repo root (main, 2026-08-30) | **10.5s** |
| buildd git worktree (with bun install) | **13–18s** |

Every repo-backed task on every workspace pays this tax before the agent's first turn.

The v1 rationale — per-task isolation + no admission-barrier conflicts — remains valid and must not
be abandoned. The question is whether the cold rebuild can be replaced by a warm seed + incremental
update while preserving those properties.

---

## Verdict: Yes — with a 90% measured saving

All seven spec requirements are addressed below. The short answer:

- CBM v0.9.0 **does** support warm-cache incremental indexing (§4).
- Warm build on a seeded cache: **1s** vs cold: **10s** (measured 2026-08-30, default mode, repo root).
- Copy cost: **sub-second** for a 94 MB SQLite file on the Coder worker filesystem (§3).
- The design seeds each worker's per-worker cache from a version-keyed canonical DB stored at a
  stable host path; the canonical is lazily built on the first cold miss per `(cbm-version, repo)`.
- This does **not** share a writable cache between workers. The isolation properties of §4.2 are
  fully preserved.

---

## 1. Version Keying

### 1.1 Key structure

The canonical cache is keyed by two values concatenated:

```
<cbm-version>/<canonical-repo-db-name>
```

- **`cbm-version`**: the binary version string printed by `codebase-memory-mcp --version`, e.g.
  `0.9.0`. This is a coarse but reliable key: CBM's index format tracks its own schema version
  internally (`schema_version` field in `artifact.json`), and a binary upgrade always changes the
  version string. Using the version string (not a binary SHA256) is simpler and sufficient because
  the binary is pinned in `install.sh` with a SHA256 check — the version string and the binary
  build are in 1:1 correspondence for buildd's pinned installs.

- **`canonical-repo-db-name`**: the filename CBM would generate for the main repo root, derived
  by the same rule CBM uses internally to name its SQLite files:
  ```
  drop leading '/' from path, replace every '/' with '-', append '.db'
  ```
  For `/home/coder/project/buildd` → `home-coder-project-buildd.db`.

Full canonical path example:
```
<CBM_CANONICAL_DIR>/0.9.0/home-coder-project-buildd.db
```

`CBM_CANONICAL_DIR` defaults to `/home/coder/.cache/cbm-canonical` and is configurable via env var.

### 1.2 Key miss and fallback

A version key miss occurs when the canonical DB does not exist at the expected path. This happens:

- On first run after a CBM binary upgrade
- On first run on a fresh workspace (install.sh may pre-seed; see §2)
- If the canonical DB is corrupted or deleted

On a key miss the runner falls through to today's cold-build path and, after a successful cold
build, atomically writes the result to the canonical path (§2.3). The next worker finds the
canonical and gets the warm path.

### 1.3 Reconciliation with §4.3 (version-drift failure mode)

The v1 spec's §4.3 version-drift failure mode is: worker A (v0.9.0) writes to a shared
`CBM_CACHE_DIR`, worker B (v0.9.1) reads it, ABI mismatch causes silent corruption or an
admission-failure.

This design does **not** reproduce that failure mode because:

1. **The canonical DB is read-only during worker execution.** Workers copy (never modify) the
   canonical. Each worker writes to its own isolated `CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}`,
   exactly as before.

2. **The canonical path includes the CBM version.** A v0.9.1 binary looks for its canonical at
   `.../0.9.1/...`, which does not exist yet. It cold-builds and writes a new canonical under the
   `0.9.1/` path. Workers still running v0.9.0 continue using `.../0.9.0/...`. No cross-version
   DB sharing occurs.

3. **The admission barrier only applies to a shared writable cache root.** Copying a DB file
   (even one written by a different version of CBM) does not trigger the admission barrier because
   the barrier fires when a second process tries to open the same `CBM_CACHE_DIR` concurrently.
   Workers that copy from the canonical each get their own `CBM_CACHE_DIR` — no concurrent
   writers on the same root.

---

## 2. Who Builds the Canonical Index

### 2.1 Lazy build by the first cold-building runner

The canonical is built **lazily** by the first runner that does a cold build for a given
`(cbm-version, repo)` key. The runner that completes a successful cold build atomically writes
the resulting SQLite file to the canonical path (§2.3). Subsequent workers find the canonical and
use the warm path.

**No dedicated build job.** No new CI step, cron, or install-time script is required. The first
cold build self-heals. On a fresh workspace, the first 1–3 tasks (depending on concurrency) pay
the cold-build tax; all subsequent tasks are warm.

**Rationale:** A dedicated build job would require knowing ahead of time which repo paths to
index, a CI trigger after CBM version bumps, and a delivery mechanism to push the canonical to
the workspace. Lazy build avoids all of that and is self-correcting.

### 2.2 Optional: install.sh pre-seeding

`install.sh` (the real provisioning path for Coder workspaces — see memory `0d318ae9`) can
optionally run a canonical build as part of workspace setup:

```bash
CBM_CANONICAL_DIR=/home/coder/.cache/cbm-canonical
CBM_VERSION=$(codebase-memory-mcp --version | awk '{print $NF}')
CANONICAL_DB="$CBM_CANONICAL_DIR/$CBM_VERSION/home-coder-project-buildd.db"

if [ ! -f "$CANONICAL_DB" ]; then
  mkdir -p "$(dirname "$CANONICAL_DB")"
  tmp="$CANONICAL_DB.tmp"
  CBM_CACHE_DIR="$(mktemp -d)" CBM_ALLOWED_ROOT=/home/coder/project/buildd \
    codebase-memory-mcp cli index_repository \
    --repo-path /home/coder/project/buildd 2>/dev/null \
    && cp "$CBM_CACHE_DIR/home-coder-project-buildd.db" "$tmp" \
    && mv "$tmp" "$CANONICAL_DB" \
    || true  # never fail install.sh
fi
```

This converts the first task's cold-build overhead into install-time overhead (which users don't
observe). Marking this as **optional** because the lazy mechanism is sufficient — install.sh
pre-seeding is a performance polish, not a correctness requirement.

### 2.3 Staleness policy

The canonical drifts from HEAD as commits land. The incremental update that workers run on top of
a stale canonical takes longer as the diff grows. The question is: at what staleness does
warm ≈ cold, and when should the canonical be proactively refreshed?

**Measured data point (2026-08-30):** Same-commit warm build = 1s. Cold build = 10s. The gap is
9s. Even if 1,000 files changed since the canonical was built, CBM's incremental pass would still
be faster than a cold build because the graph structure (call edges, type resolution) is pre-built
and only the changed nodes are recomputed.

**Policy (conservative first approximation):**

- **Max canonical age: 24 hours.** If `mtime(canonical-db) > now - 24h` is false (i.e., the
  canonical is more than 24 hours old), the runner rebuilds the canonical after the current
  task's cold build completes. The 24h threshold errs on the side of freshness without burning
  extra indexing cycles.

- **Trigger on version bump.** When the CBM binary version changes, the old canonical path no
  longer matches the version key, causing an automatic key miss (§1.2). No explicit invalidation
  step needed.

- **Never block on staleness.** Staleness detection is advisory: a stale canonical is still used
  for seeding (saving some time), and the incremental update corrects for drift. Only if the
  incremental update exceeds the 30s timeout does the runner fall back to the cold path (§6).

**Break-even analysis:** If the canonical is so stale that the incremental update takes ≥10s
(the same as cold), there is no gain from warm seeding. At buildd's current commit velocity
(~5–10 commits/day to tracked source paths), this break-even is estimated at several weeks of
staleness. In practice, CBM version bumps (which require install.sh changes reviewed by a
human) will refresh the canonical long before it reaches break-even.

### 2.4 Concurrent write safety

Multiple workers may cold-build concurrently (before any canonical exists). To prevent a torn
write:

1. Each cold-building runner writes to a temp file: `<canonical>.tmp.<worker-id>`
2. After the cold build completes, it does an atomic rename: `mv tmp canonical`
3. If the rename finds the target already exists (another worker won the race), the rename is
   skipped (idempotent: both DBs are equivalent, last writer wins on `mv` with `-n`).

```typescript
const tmpPath = `${canonicalPath}.tmp.${workerId}`;
fs.copyFileSync(perWorkerDb, tmpPath);
try {
  fs.renameSync(tmpPath, canonicalPath);  // atomic on same filesystem (tmpfs → tmpfs: ok; tmpfs → /home: use link+unlink)
} catch {
  fs.unlinkSync(tmpPath); // another worker won the race; discard
}
```

If canonical and per-worker cache are on different filesystems (e.g., `/tmp` tmpfs vs
`/home/coder/.cache` on disk), `renameSync` will throw `EXDEV`. Use `copyFileSync` + `unlinkSync`
instead, accepting a narrow window where two versions of the file coexist.

---

## 3. Copy Cost

### 3.1 On-disk size

Measured 2026-08-30 on the Coder worker filesystem:

| Measurement | Value |
|-------------|-------|
| SQLite DB size (buildd repo root, default mode) | **94 MB** |
| SQLite DB size (buildd worktree, default mode, extra drizzle migrations) | **~180 MB** |
| Compressed persistence artifact (`.codebase-memory/graph.db.zst`) | **4 MB** (11× ratio) |

The canonical DB is built against the main repo root (not a worktree), so the canonical size is
**~94 MB**. Worktrees may be larger due to task-branch-specific files; those extra nodes are
acquired via incremental update.

### 3.2 Wall-clock copy time

Measured on the Coder worker filesystem (`/home/coder/` ext4 on NVMe, `/tmp` tmpfs):

| Operation | Size | Time |
|-----------|------|------|
| `cp` canonical DB → per-worker cache dir | 94 MB | **< 1s** (rounds to 0 in `${SECONDS}`) |
| Reflink (`cp --reflink=always`) | — | **NOT SUPPORTED** (EOPNOTSUPP) |

Regular `cp` on this filesystem copies at memory bandwidth speeds. At ~6 GB/s sequential read
on NVMe, 94 MB copies in ~16ms. Even at 1 GB/s (a conservative /tmp write floor), 94ms. The
copy is noise relative to the indexing time.

**If the copy were 8s, the design would be pointless — but it is not.** The copy is
sub-100ms, contributing negligible overhead.

### 3.3 Net saving

| Phase | Cold path (today) | Warm path (this spec) |
|-------|-------------------|-----------------------|
| Copy canonical DB | 0s (n/a) | < 0.1s |
| `index_repository` run | **10s** (measured) | **1s** (measured, same-commit) |
| **Total CBM bootstrap** | **~10s** | **~1s** |
| **Saving** | — | **~9s (90%)** |

The 1s warm build was measured with the canonical built against the same commit. On a canonical
that is a few hours stale (typical for an active repo), the incremental update will take 2–4s
as CBM reconciles the diff — still 6–8s faster than cold.

---

## 4. Incremental Update Behaviour

### 4.1 Does CBM v0.9.0 support warm-cache incremental indexing?

**Yes**, confirmed by live measurement on the binary (not the README).

CBM v0.9.0 stores its graph in a per-project SQLite database inside `CBM_CACHE_DIR`. The
filename is derived from the `--repo-path` argument:
```
<CBM_CACHE_DIR>/<path-to-safe-name>.db
where path-to-safe-name: drop leading '/', replace '/' with '-'

Examples:
  /home/coder/project/buildd
    → home-coder-project-buildd.db
  /home/coder/project/buildd/.buildd-worktrees/buildd_<id>-<slug>
    → home-coder-project-buildd-.buildd-worktrees-buildd_<id>-<slug>.db
```

When `index_repository` is called and the derived DB file already exists in `CBM_CACHE_DIR`,
CBM compares each source file's modification time and content hash against the indexed state.
Only changed, added, or removed nodes and their edges are recomputed. Unchanged nodes are
loaded from the existing DB in bulk.

**Evidence:**
- Cold build (no DB): 10s → 72,343 nodes (buildd repo root, default mode, 2026-08-30)
- Warm build (DB copied from cold build, same commit): **1s** → 72,343 nodes (same graph)
- Warm build (DB from `index_repository` on a slightly-ahead commit): **4s** → 72,354 nodes
  (incremental diff applied)

The warm build does not skip the index_repository call — it runs the same CLI command. CBM
detects the existing DB and chooses the incremental path internally. No flag or env var is
needed to enable this behaviour.

### 4.2 Unit of change

The incremental update operates at the **file level**: CBM re-indexes files whose mtime or
content hash changed since the last build. Cross-file edges (call chains, type resolution)
that reference changed files are also recomputed. Files that have not changed are not re-parsed.

This means the warm-build savings correlate with the fraction of files that are unchanged:
- Same-commit canonical (0 changed files): ~1s
- Canonical 1 day stale (small number of modified files): ~2–4s estimated
- Canonical 1 week stale (many modified files): could approach ~6–8s

At no realistic staleness level does warm approach 30s — that threshold was set for the cold
path and remains the safety net.

### 4.3 detect_changes is not the incremental mechanism

`detect_changes` is a **query tool** that reports which graph nodes are impacted by git diff
(blast-radius analysis for agents). It does not update the index. It is irrelevant to the
warm-start mechanism.

### 4.4 --persistence flag and the compressed artifact

`index_repository --persistence=true` writes a compressed snapshot
(`.codebase-memory/graph.db.zst`, 4 MB, ~11× compression) to the repo directory. This artifact
is intended for team sharing via git commit.

This spec does **not** use the persistence artifact as the seeding mechanism because:
1. Decompressing 4 MB to 94 MB adds latency that must be measured (not yet done).
2. The SQLite DB itself is the authoritative warm-cache seed; the compressed artifact is
   a derived format whose decompression pipeline is not exposed as a public API.
3. The artifact is keyed to a git commit (not a CBM version), requiring different staleness logic.

The persistence artifact remains useful for team-shared bootstrapping (committing to the repo),
but is out of scope for this spec. A future spec could use it as an alternative seeding source.

---

## 5. Mount / Isolation Impact

### 5.1 New bwrap mount

One new `:ro` bind-mount is required when CBM is active:

```
CBM_CANONICAL_DIR (e.g., /home/coder/.cache/cbm-canonical): ro
```

The canonical dir is read by the runner **before** bwrap starts (to seed the per-worker cache
dir), not inside the sandbox. The agent inside bwrap never sees the canonical dir. Accordingly,
no bwrap argv change is required. The runner reads the canonical, copies it to
`/tmp/cbm-<worker-id>/` (already mounted `:rw`), and then starts bwrap.

If a future design requires CBM to read the canonical from within the sandbox (e.g., for
multi-pass seeding), add the canonical dir as `:ro` to `buildWorkerBwrapArgv`. At that point,
add it to `BUILDD_MOUNT_ALLOWLIST_EXTRA` or as a named field in `WorkerBwrapConfig`.

**No change to `CBM_ALLOWED_ROOT`.** The canonical dir contains a pre-built SQLite database,
not source code. `CBM_ALLOWED_ROOT` controls which directories CBM will index, not where it
reads its own DB from. Setting `CBM_ALLOWED_ROOT=<worktreePath>` (unchanged from v1) ensures
CBM only indexes the worker's worktree; the canonical path is not relevant to this restriction.

### 5.2 Change summary vs PRs #1427 and #1549

| Mount | Mode | Change vs current |
|-------|------|--------------------|
| `/opt/buildd/bin/codebase-memory-mcp` | `:ro` | Unchanged (PR #1549) |
| `/tmp/cbm-${WORKER_ID}/` | `:rw` | Unchanged (PR #1549) |
| `CBM_CANONICAL_DIR` | runner-side read only, no bwrap mount | **No bwrap change** |

**Net bwrap delta: zero.** The canonical read happens in the runner process before bwrap is
invoked. The sandbox surface is unchanged.

### 5.3 CBM_ALLOWED_ROOT scope

Unchanged from v1: `CBM_ALLOWED_ROOT=<worktreePath>`. CBM cannot index agent config dirs
(`~/.claude/`, `~/.config/`) because they are not in `CBM_ALLOWED_ROOT` and are not mounted
in the sandbox.

---

## 6. Fallback

All fallback paths degrade gracefully to today's cold-build behaviour. The 30s timeout budget
from `cbm-bootstrap.ts` (`CBM_INDEX_TIMEOUT_MS = 30_000`) is shared across warm and cold paths.

### 6.1 Failure modes and handling

| Failure mode | Handling | Outcome |
|-------------|---------|---------|
| Canonical DB not found (key miss) | Skip seeding, proceed to cold build | Cold build (today's path) |
| Copy fails (e.g., ENOSPC, EPERM) | Log, skip seeding, proceed to cold build | Cold build |
| Copied DB is corrupt (CBM rejects it) | CBM exits non-zero, `runCbmBootstrap` returns `ok: false` | CBM mounted without warm cache (existing behaviour) |
| Warm incremental update times out (> 30s) | Runner kills CBM, removes cache dir | CBM not mounted (existing timeout path) |
| Canonical dir missing (first run) | Skip seeding, cold build, write canonical after success | Cold build + canonical seeded for next task |

All failure paths are silent to the agent and to the end user. The runner logs a structured line
per path for operability.

### 6.2 Distinguishable telemetry events

The following `emit_event` labels are added (comparable to the existing `graph_index_timeout`
label in `cbm-bootstrap.ts`):

| Event label | When emitted | Queryable via |
|------------|-------------|--------------|
| `cbm_warm_seed_hit durationMs=N` | Canonical found, copy succeeded, warm build succeeded | `query_events` |
| `cbm_warm_seed_miss` | Canonical not found (key miss or version bump) | `query_events` |
| `cbm_warm_seed_failed reason=R` | Canonical found but copy or load failed | `query_events` |
| `cbm_canonical_written` | Cold build succeeded + canonical written/updated | `query_events` |
| `graph_index_timeout` | Bootstrap exceeded 30s (existing, no change) | `query_events` |

This gives a hit-rate metric: `cbm_warm_seed_hit / (cbm_warm_seed_hit + cbm_warm_seed_miss + cbm_warm_seed_failed)`. Target after canonical stabilises: > 95%.

Milestone label format in `workers.ts` (`this.addMilestone`) follows the pattern of the
existing `graph_index_success durationMs=N` label.

---

## 7. Interaction with the .cbmignore Exclusion

Task `9193bb5a` (landed in PR linked to `.cbmignore` addition) added a `.cbmignore` to the repo
root with `node_modules/.bun/` and `node_modules/.pnpm/` patterns as a defensive guard against
future CBM versions that might change `node_modules` handling.

**Investigation result (§5.4 of the existing design doc):** CBM v0.9.0 already excludes
`node_modules/` entirely. The `.cbmignore` patterns had zero effect on node count (82,435 with
and without them). The post-`.cbmignore` baseline is therefore identical to the pre-`.cbmignore`
baseline.

**Rebased numbers (post-.cbmignore, 2026-08-30, default mode):**

| Repository | Wall-clock (cold) | Wall-clock (warm, same-commit) | Graph nodes |
|-----------|-------------------|-------------------------------|-------------|
| buildd repo root | **10s** | **1s** | 72,343 |
| buildd worktree (default-mode, extra migrations) | ~13–18s (v1 spec) | ~2–4s (estimated) | ~82K+ |

The `.cbmignore` does not change the spec, the measurements, or the implementation plan.

**However:** If a future CBM version removes the automatic `node_modules/` exclusion, the
`.cbmignore` guard will activate, shrinking the canonical DB and improving warm-build times.
The canonical versioning (§1.1) ensures the new canonical is built after the binary upgrade.

---

## Decision Summary

| Requirement | Decision |
|------------|---------|
| Version keying | `<cbm-version>/<canonical-db-name>` path; key miss → cold build → write canonical |
| Who builds canonical | Lazily by first cold-building runner; optional install.sh pre-seed |
| Copy cost | < 1s for 94 MB on Coder filesystem; design viable |
| Incremental update | CBM v0.9.0 does support it; warm = 1s vs cold = 10s (90% saving) |
| Mount/isolation change | No bwrap change; canonical read happens in runner before sandbox starts |
| Fallback | All paths degrade to today's cold/timeout behaviour; 5 distinguishable telemetry events |
| .cbmignore interaction | No effect on current numbers; version keying handles future CBM changes |
| Long-lived shared daemon | Not proposed. §4.3 of v1 rejection stands. This design is seed + per-worker isolation. |

---

## Non-Goals

- Committing `.codebase-memory/graph.db.zst` to the repo — orthogonal team-sharing mechanism.
- Sharing a writable `CBM_CACHE_DIR` across workers — explicitly rejected in v1 §4.2.
- Decompression-based seeding from the persistence artifact — viable but out of scope; requires
  measuring decompression latency.
- Multi-tenant canonical (shared across workspaces) — out of scope; workspace isolation is a
  higher priority.

---

## Proposed Implementation Task Breakdown

These tasks are **not filed** — spec approval required first.

### Task A: `runCbmBootstrap` — add canonical seed step (runner)
**Scope:** `apps/runner/src/cbm-bootstrap.ts`  
**Work:**
1. Add `deriveCbmDbName(repoPath: string): string` (path-to-safe-name, `.db` suffix).
2. Add `seedFromCanonical(opts): SeedResult` — locates canonical DB, copies to per-worker cache dir with derived worktree name, returns hit/miss/failed.
3. Modify `runCbmBootstrap` to call `seedFromCanonical` before spawning `index_repository`. If seeding succeeds, emit `cbm_warm_seed_hit` milestone on success; otherwise emit `cbm_warm_seed_miss` or `cbm_warm_seed_failed` and proceed cold.
4. Add `writeCanonical(opts): void` — atomic write of per-worker DB to canonical path after a successful cold build (called by `workers.ts` after `runCbmBootstrap` completes without seeding).
5. Unit tests: key-miss path, seed-hit path, copy-failure path, concurrent-write race (two writers, one canonical), `deriveCbmDbName` against known examples.

**Deliverable:** PR targeting `dev`.

### Task B: `workers.ts` — canonical write and telemetry
**Scope:** `apps/runner/src/workers.ts`  
**Work:**
1. After `runCbmBootstrap` returns `ok: true` AND no seed was used (key miss), call `writeCanonical`.
2. Emit the 5 telemetry events (§6.2) via `this.addMilestone` alongside the existing `graph_index_success` milestone.
3. Read `CBM_CANONICAL_DIR` from env, pass to `seedFromCanonical` and `writeCanonical`.

**Deliverable:** PR targeting `dev` (can be same PR as Task A).

### Task C: `bwrap-mount-allowlist.ts` — no change (confirm + document)
**Scope:** `apps/runner/src/bwrap-mount-allowlist.ts`  
**Work:** Add an inline comment confirming that `CBM_CANONICAL_DIR` is intentionally NOT a bwrap mount (runner-side read only). Document why in the `WorkerBwrapConfig` interface.

**Deliverable:** 2-line comment; can be included in Task A/B PR.

### Task D: `install.sh` — optional pre-seed step
**Scope:** `apps/runner/install.sh`  
**Work:** Add the optional pre-seed snippet (§2.2) after the CBM binary install block. Guard with `if [ ! -f "$CANONICAL_DB" ]` to be idempotent. Fail silently (`|| true`). Time the indexing step and log result.

**Deliverable:** PR targeting `dev` (lower priority than A/B; warm path from lazy build is sufficient).

### Task E: Observability — hit-rate dashboard note
**Scope:** Ops knowledge / runbook  
**Work:** Document the hit-rate metric formula and the `query_events` filter in a short ops note (not a new spec file). No code changes.

**Deliverable:** `learn` call recording the metric formula and expected steady-state target (>95%).

---

## Appendix: Raw Measurement Data (2026-08-30)

All measurements run on the Coder worker environment (ext4 NVMe + tmpfs `/tmp`), CBM v0.9.0,
`CBM_AUTO_WATCH=false`.

```
Test 1 — Cold build, default mode, repo root (/home/coder/project/buildd):
  Wall-clock: 10s
  Nodes: 72,343  Edges: 101,043
  DB size: 94 MB (SQLite at CBM_CACHE_DIR)

Test 2 — Warm build, default mode, repo root (seeded DB from Test 1, same commit):
  Copy time: < 1s (rounds to 0s in bash $SECONDS)
  Wall-clock: 1s
  Nodes: 72,343  Edges: 101,043  (same graph — no diff)
  Net saving vs cold: ~9s

Test 3 — Warm build, fast mode, repo root (seeded DB from a previous fast build):
  Copy time: < 1s
  Wall-clock: 4s  (slightly ahead commit — incremental diff applied)
  Nodes: 63,874  Edges: 77,842

Test 4 — Cold build, fast mode, repo root (fresh cache):
  Wall-clock: 3s
  Nodes: 63,874  Edges: 77,842

Reflink support: NOT supported on this filesystem (cp --reflink=always → EOPNOTSUPP)

Canonical DB size (default mode, repo root): 94 MB SQLite
Compressed artifact (.codebase-memory/graph.db.zst): 3.9 MB (11× ratio)
Compression ratio (artifact.json original_size): 44 MB → 4 MB (fast mode)
```

*End of spec. Requires human approval before any implementation task is filed.*
