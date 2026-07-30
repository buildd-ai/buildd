# Codebase-Memory-MCP: Structural Code Intelligence Layer for Buildd Workers

**Status:** Proposed
**Related:**
- `docs/design/knowledge-graph-retrieval.md` — offline entity/graph layer for KnowledgeStore (distinct, complementary)
- `packages/shared/src/types.ts:658` — `McpServerConfig` type
- `apps/web/src/lib/default-roles.ts` — role/skill config and `allowedTools`
- `apps/runner/src/workers.ts` — `buildWorkerMountAllowlist`, `buildWorkerBwrapArgv`
- `packages/core/mcp-tools.ts` — `extractImplementationAnchors`, `spec_compare` two-hop bridge (PR #1429)
- Prior task `a61de0b5` — spec_compare vocabulary gap fix
- Prior task `a51c5358` — knowledge layer recon

---

## Problem

Buildd workers answer structural code questions — "what calls this function?", "what breaks if I change this type?", "what does this module import?" — by sequentially reading files and grepping. This is expensive: the arXiv preprint (Vogel et al., 2603.27277) measures 10× more tokens and 2.1× more tool calls versus a graph-backed approach, at equal or better answer accuracy for structural questions. Workers on structural tasks spend most of their context budget on file navigation rather than reasoning.

The KnowledgeStore (`corpus=code`) addresses a different failure mode — semantic retrieval ("find code about X") — and does not model call chains, blast radius, or symbol reference graphs. The two systems are not in competition; they serve different query classes.

---

## Proposal

Adopt **DeusData/codebase-memory-mcp** (MIT, v0.9.1-rc.1, SLSA Level 3) as a harness-owned MCP server available to opted-in roles. The server exposes structural graph queries (call chains, callers, blast radius, hub detection, architecture overview) via 15 MCP tools. Workers call these tools instead of reading files to answer structural questions.

**Crux:** the tool by design writes to agent config files (`~/.claude.json`, etc.) during its `install` command. We must never run `install` — instead wire the server explicitly via the role's `mcpServers` config (harness-owned boundary). If this trust boundary is violated, the tool will rewrite agent configuration outside buildd's control.

---

## 1. Positioning: Structural Graph vs. KnowledgeStore Semantic Retrieval

These are two orthogonal retrieval axes. Workers need both.

| Query class | Route to | Example |
|-------------|----------|---------|
| "Find code about feature X" | KnowledgeStore `corpus=code` (hybrid vector+BM25) | "show me the claim route" |
| "What calls function Y?" | codebase-memory-mcp `trace_path` / `search_graph` | "what calls `buildWorkerBwrapArgv`?" |
| "What breaks if I change type Z?" | codebase-memory-mcp `search_graph` blast-radius | "dependents of `McpServerConfig`" |
| "What does file A import?" | codebase-memory-mcp `get_architecture` | "imports of `role-config.ts`" |
| "Does the spec match the code?" | `spec_compare` (queries both `{wsId}:spec` and `{wsId}:code`) | "is `knowledgeIsolation` documented?" |
| "Summarize recent work on topic X" | KnowledgeStore `corpus=task|pr|memory` | "what changed in claim logic?" |
| "What is the call chain from A to B?" | codebase-memory-mcp `trace_path` | "path from HTTP handler to DB write" |

**Rule:** codebase-memory-mcp is never consulted for semantic or historical retrieval. KnowledgeStore is never expected to answer structural graph questions. The graph complements; it does not replace.

Workers should call `search_graph` or `trace_path` first when the question contains structural language ("caller", "callee", "import", "dependency", "blast radius", "change impact", "what uses X"). They fall back to file reads only if the graph cannot answer (e.g., the symbol is not indexed, the answer spans runtime behaviour not visible at AST level).

---

## 2. Integration Model

### 2.1 Binary delivery: pre-baked in worker image

The `codebase-memory-mcp` binary MUST be pinned and pre-baked into the worker image, not fetched at runtime.

**Why:** runtime `curl | bash` installs are a supply-chain attack surface and fail in offline/air-gapped runners. Version drift between the image and a runtime download would trigger the admission barrier (§4).

**How:**
```dockerfile
# In the Coder worker image Dockerfile
ARG CBM_VERSION=0.9.0
ARG CBM_SHA256=<sha256-of-linux-amd64-binary>
RUN curl -fsSL \
    "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-linux-amd64" \
    -o /opt/buildd/bin/codebase-memory-mcp \
  && echo "${CBM_SHA256}  /opt/buildd/bin/codebase-memory-mcp" | sha256sum -c \
  && chmod +x /opt/buildd/bin/codebase-memory-mcp
```

The SHA256 and version are pinned in the Dockerfile ARG. Updating requires a new image build + push, not a hotfix script.

**Do NOT run `codebase-memory-mcp install`** at any point — this is the config-write boundary (§3).

### 2.2 Role-level MCP server config

codebase-memory-mcp is registered as a role-level MCP server via the `mcpServers` field in the role/skill record. This matches the existing `McpServerConfig` interface (`packages/shared/src/types.ts:658`).

Example role registration (via `buildd action=register_skill` or `update_skill`):
```json
{
  "mcpServers": {
    "codebase-memory": {
      "command": "/opt/buildd/bin/codebase-memory-mcp",
      "args": ["mcp"],
      "env": {
        "CBM_CACHE_DIR": "/tmp/cbm",
        "CBM_ALLOWED_ROOT": "__WORKSPACE_DIR__",
        "CBM_AUTO_WATCH": "false",
        "CBM_LOG_LEVEL": "warn"
      },
      "type": "stdio"
    }
  }
}
```

`CBM_CACHE_DIR` must be a per-worker-instance path (see §4). `CBM_ALLOWED_ROOT` must be set to the workspace directory (prevents indexing paths outside the task's scope). `CBM_AUTO_WATCH=false` disables the background file-change watcher (unnecessary overhead in an ephemeral task environment).

The runner resolves `__WORKSPACE_DIR__` to the actual worktree path at spawn time, following the same pattern as other env substitutions in `workers.ts`.

### 2.3 Bootstrap sequence

The harness (not the agent) runs the initial index build:

```
1. Worker claims task → runner resolves role config
2. Runner detects mcpServers includes "codebase-memory"
3. Runner sets CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}
4. Runner starts CBM as stdio MCP subprocess (args: ["mcp"])
5. Runner calls index_repository(path=<worktree>) over the MCP session BEFORE handing off to the agent
6. index_repository completes (estimate: 2–10s for buildd repo, see §5)
7. Agent session starts with the graph pre-built and queryable
```

Pre-building the index before the agent starts avoids the agent spending its first turn on infrastructure. If indexing fails or exceeds the time budget, the runner proceeds without CBM (§5 fallback).

### 2.4 Allowlisted MCP tools

Of the 15 tools exposed by codebase-memory-mcp, workers are allowed to call the following subset. Claude Code enforces this via the role's `allowedTools` list (MCP tool names follow the `mcp__<server>__<tool>` pattern):

**Allowed (read-only structural queries + bootstrap):**
| Tool | Purpose | Notes |
|------|---------|-------|
| `mcp__codebase-memory__index_repository` | Build/refresh the graph index | Bootstrap step; agents may re-call after large edits |
| `mcp__codebase-memory__index_status` | Check index health | Read-only |
| `mcp__codebase-memory__list_projects` | List indexed projects | Read-only |
| `mcp__codebase-memory__search_graph` | Semantic + structural search | Primary query tool |
| `mcp__codebase-memory__trace_path` | Call chain tracing | "How do I get from A to B?" |
| `mcp__codebase-memory__detect_changes` | Changed-file impact analysis | Blast radius |
| `mcp__codebase-memory__query_graph` | Read-only Cypher subset | Advanced structural queries |
| `mcp__codebase-memory__get_graph_schema` | Schema introspection | Read-only |
| `mcp__codebase-memory__get_code_snippet` | Retrieve code by symbol | Read-only |
| `mcp__codebase-memory__get_architecture` | Module-level import/dep overview | Read-only |
| `mcp__codebase-memory__search_code` | Structural code search | Read-only |
| `mcp__codebase-memory__check_index_coverage` | Coverage report | Read-only (v0.9.1+) |

**Blocked (not in `allowedTools`):**
| Tool | Reason |
|------|--------|
| `mcp__codebase-memory__delete_project` | Destructive; agent should never delete graph state |
| `mcp__codebase-memory__manage_adr` | Writes Architecture Decision Record files to the codebase — violates task isolation |
| `mcp__codebase-memory__ingest_traces` | Ingests external trace data; undefined trust boundary |

---

## 3. Trust Boundary

codebase-memory-mcp's `install` command auto-detects 43 agent surfaces and writes MCP configuration entries and lifecycle hooks into each one (`~/.claude.json`, `~/.continue/config.yaml`, etc.). This must be completely bypassed.

### 3.1 Harness-owned wiring (the "explicit server" pattern)

The community pattern for harness-owned MCP wiring (analogous to what the pi-agent community calls "explicit server mode") is:

1. **Never run `install`.** The binary is only invoked as `codebase-memory-mcp mcp` (stdio MCP server mode) or `codebase-memory-mcp cli <tool>` (CLI one-shot).
2. **Harness supplies the config.** The MCP connection is established by the runner, not by auto-detection. Config lives in the role record's `mcpServers` field, not in `~/.claude.json` or `.mcp.json`.
3. **Harness supplies the env.** All CBM configuration (`CBM_CACHE_DIR`, `CBM_ALLOWED_ROOT`, etc.) is injected by the runner as environment variables, not read from `~/.config/codebase-memory-mcp/config.json`.

### 3.2 Filesystem paths read/written (reconciled with mount allowlist)

**Reads (required):**
| Path | Mode | Mount status |
|------|------|-------------|
| `/opt/buildd/bin/codebase-memory-mcp` | ro | Must add via `BUILDD_MOUNT_ALLOWLIST_EXTRA` |
| `<worktreePath>/` | ro (index walk) | Already mounted rw as worktreePath |
| `<worktreePath>/.gitignore`, `.cbmignore` | ro | Already in worktree mount |
| `<worktreePath>/package.json`, `go.mod`, etc. | ro | Already in worktree mount |

**Writes (required):**
| Path | Mode | Mount status |
|------|------|-------------|
| `/tmp/cbm-${WORKER_ID}/` | rw | Must add via `BUILDD_MOUNT_ALLOWLIST_EXTRA` |

**Writes (must be suppressed):**
| Path | Suppression method |
|------|-------------------|
| `~/.claude.json` (and other agent configs) | Never run `install`; these paths are not mounted in the bwrap sandbox |
| `~/.config/codebase-memory-mcp/config.json` | Not mounted; env vars override all config values |
| `<worktreePath>/.codebase-memory/graph.db.zst` | Not enabled; team snapshot is opt-in and disabled by default |

**Mount allowlist additions** to `buildWorkerMountAllowlist` (or `BUILDD_MOUNT_ALLOWLIST_EXTRA`) when codebase-memory is enabled for a role:
```
/opt/buildd/bin/codebase-memory-mcp:ro
/tmp/cbm-${WORKER_ID}:rw
```

The runner resolves the worker-ID-scoped `/tmp/cbm-...` path at the same time it sets `CBM_CACHE_DIR`.

### 3.3 `CBM_ALLOWED_ROOT` as multi-tenant guard

`CBM_ALLOWED_ROOT` restricts which directories CBM will index. Set it to `<worktreePath>` at spawn time. This prevents a worker from calling `index_repository` on arbitrary host paths (e.g., other workspaces, system directories). This is the primary multi-tenant isolation mechanism (§8).

---

## 4. Daemon / Cache Semantics

### 4.1 Admission barrier

CBM enforces an OS-backed admission barrier: **all active processes using the same `CBM_CACHE_DIR` must run the exact same version, build, coordination ABI, and cache format.** Mismatches cause the second process to fail with a conflict error logged to `${CBM_CACHE_DIR}/logs/daemon-conflicts.ndjson`.

This is a correctness constraint, not just a performance constraint. Sharing a cache root across workers running different binary versions (e.g., during a rolling image update) will cause admission failures.

### 4.2 v1 decision: fresh per-task cache root, no shared cache volume

**Decision:** Each worker gets its own `CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}`. No shared cache volume between workers.

**Rationale:**
- Eliminates admission barrier conflicts entirely
- Eliminates version drift risk during image updates
- The per-task cache is ephemeral (deleted when the worker exits)
- Index build time for buildd-scale repos is 2–10 seconds (§5) — short enough that per-task rebuilds are acceptable

**Trade-off:** each task re-indexes from scratch. On the buildd repo at estimated 2–10 seconds build time, this is acceptable overhead. If a repo grew to Django scale (~6 seconds) or larger, we would revisit shared cache.

### 4.3 Version drift failure mode (if shared cache is ever proposed)

**Do not share CBM_CACHE_DIR across workers without these conditions all being simultaneously true:**

1. All workers in the pool are running the **same binary SHA256** (identical build, not just same version string)
2. The cache root is **not accessible during image update rollout** (zero-downtime updates must drain the pool before updating the binary)
3. A **distributed lock** is held by the first writer; all others retry with a timeout

The version-drift failure mode: worker A (v0.9.0) writes a graph to the shared cache. Worker B (v0.9.1) starts, sees a cache root with a different ABI, and either (a) fails its admission check or (b) silently reads corrupt graph data. Option (b) is undetectable without explicit version tagging in the cache header.

Until a shared-cache design is fully specified and the cache format is understood to be version-stable, shared cache MUST NOT be enabled.

---

## 5. Performance Budget

### 5.1 Reference measurements

From the codebase-memory-mcp preprint and README:

| Repository | Files | LOC | Index time |
|-----------|-------|-----|-----------|
| Average repo | — | — | milliseconds |
| Django | ~3,000 | ~49K nodes | ~6 seconds |
| Linux kernel | ~75,000 | 28M LOC | ~3 minutes |

RAM: in-memory SQLite with LZ4 compression; memory released after indexing. Peak RAM is proportional to repo size.

### 5.2 Buildd repo estimate

The buildd monorepo contains approximately 500–1,500 TypeScript/TSX source files across `apps/` and `packages/`. Based on the Django comparison (~3,000 files → 6 seconds), buildd at roughly 1/3 the file count should index in **2–10 seconds**, with RAM peak in the **100–300 MB** range.

**Measurement method for implementation phase:** run `codebase-memory-mcp cli index_repository <repo_path>` with `CBM_MEM_BUDGET_MB=512` on the buildd repo in the Coder environment and record wall-clock time and peak RSS.

### 5.3 Acceptable overhead and fallback

**Acceptable bootstrap overhead:** ≤ 30 seconds wall-clock.

**Fallback:** if `index_repository` does not complete within 30 seconds (runner-side timeout), the runner:
1. Terminates the CBM process
2. Removes the partial cache dir
3. Starts the agent session without CBM in the MCP server list
4. Emits a `graph_index_timeout` event (scannable via `query_events`)
5. Logs the fallback in the task's progress notes so the agent is aware

The fallback is silent-to-the-user (no hard failure). Workers without CBM fall back to file reads for structural questions — the same behaviour as today.

**Memory cap:** set `CBM_MEM_BUDGET_MB=512` in the worker env. CBM respects this cap and will terminate indexing cleanly rather than OOMing the worker.

---

## 6. Spec_compare Interaction

### 6.1 Current vocabulary gap and the two-hop fix

The current spec_compare vocabulary gap (task `a61de0b5`, PR #1429) arose because prose queries ("auto-merge approval gate") produce near-zero code evidence against identifier-heavy embeddings. The two-hop fix extracts implementation anchors (file paths, camelCase symbols, PascalCase types) from spec chunks via regex, then runs a second lexical query against the code corpus using those anchors.

This works well when specs contain traceability rows (`BT-N → apps/web/src/...`) or explicit symbol names. It degrades when specs use only prose and the symbol names have changed since the spec was written.

### 6.2 What symbol-graph grounding could add

With codebase-memory-mcp available at spec_compare call time, the anchor extraction step could be replaced or augmented:

1. Probe the graph via `search_graph(query=<anchor_candidate>)` for each candidate anchor
2. The graph returns exact symbol matches, their defining files, and callers
3. Use the matched symbols (canonical AST names, not regex guesses) as the lexical anchors for the second code query

This would handle:
- **Symbol renames:** the graph finds the new name; the regex anchor would silently produce nothing
- **Ambiguous abbreviations:** the graph disambiguates "PgStore" → `PgVectorStore` vs `PgStoreLegacy`

### 6.3 Recommendation

Treat symbol-graph grounding of spec_compare anchors as a **future enhancement** to the existing two-hop bridge, not an immediate replacement. Prerequisites:

1. CBM must be integrated and stable (this spec)
2. The graph must be available at spec_compare call time (requires CBM to be running as a server, not just as an offline index)
3. The latency budget for spec_compare must absorb 2–3 additional graph round-trips

No changes to spec_compare are in scope for this spec. Implementation of the graph-grounding bridge would be a separate task gated on Phase 1 of this integration completing successfully.

---

## 7. Rollout Plan

### Phase 0: Pilot (buildd workspace only)

**Scope:** one role in the buildd workspace opts in. Suggested: the **Builder** role, which handles the heaviest structural navigation tasks.

**Enabling changes:**
1. Add CBM binary to the Coder worker image (pinned SHA256, see §2.1)
2. Add mount allowlist entries for binary path and CBM cache dir (§3.2)
3. Update the Builder role's `mcpServers` config to include `codebase-memory` (§2.2)
4. Update Builder's `allowedTools` to include the 12 allowed CBM tool names (§2.4)
5. Implement bootstrap sequence in runner (pre-call `index_repository`, timeout/fallback, §2.3)

**Success metrics** (measured over ≥ 20 tasks using structural-question-heavy prompts):

| Metric | Baseline (no CBM) | Target (with CBM) | How measured |
|--------|------------------|-------------------|--------------|
| Input tokens per task (structural tasks) | ~TBD | −30% | `update_progress.inputTokens` vs task category |
| Tool calls per task (Read/Grep/Glob) | ~TBD | −40% | tool usage in task worker logs |
| Task outcome quality (structural questions) | ~TBD | No regression | Human review of 5-task sample per week |
| Bootstrap overhead | 0s (no CBM) | ≤ 10s p95 | `graph_index_timeout` event absence |
| Index fallback rate | n/a | < 5% | `graph_index_timeout` events / total CBM tasks |

Baselines are established in the first week of pilot using tasks WITHOUT CBM enabled (control group).

### Phase 1: Role-level opt-in

After ≥ 4 weeks of pilot with positive metrics, expose CBM as a role-level capability that workspace admins can enable for any role via the `mcpServers` config field. No dashboard changes required in Phase 1 — admins use the skill API directly.

Document the role config snippet in `docs/specs/` and the buildd-docs site.

### Build-vs-adopt note

The existing `docs/design/knowledge-graph-retrieval.md` proposes building a SCIP-based offline entity/graph layer for the KnowledgeStore (Phases 2–3 of that design). That plan addresses a different problem: persistent cross-task structural knowledge ingested at CI time and queryable via the vector store.

codebase-memory-mcp addresses **live structural queries at task time**, including over uncommitted work-in-progress that hasn't been merged (and thus isn't in the CI-ingested index). The two approaches are complementary, not competing.

We are not extending our own basic AST work (ast-grep + SCIP plan from `knowledge-graph-retrieval.md`) for the following reasons:
- codebase-memory-mcp is battle-tested on 31+ repositories including the Linux kernel; our AST plan is unproven at that scale
- It handles 158 languages, LSP-backed type resolution for 12, and cross-service HTTP/gRPC linking — capabilities that would take months to build
- It maintains SLSA L3 provenance independently; we do not need to own the security surface
- Our competitive advantage is task coordination, not AST parsing

The SCIP-based offline graph (knowledge-graph-retrieval.md Phase 3) should still be built, but for a different purpose: populating the KnowledgeStore with stable structural edges that survive across sessions, visible in `spec_compare`, and queryable via `query_knowledge`. codebase-memory-mcp serves the live task-time use case.

---

## 8. Risks

### 8.1 Upstream project health

**Project:** DeusData/codebase-memory-mcp — 36,600 stars, 2,900 forks, 1,894 commits on main, v0.9.1-rc.1 as of 2026-07-30.

**Assessment:** Active, high-momentum project. 289 open issues and 110 open PRs indicate a healthy contributor base, not abandonment. Latest release (v0.9.1-rc.1) is a pre-release (use v0.9.0 stable for production pinning).

**win4r fork:** The `win4r/codebase-memory-mcp` fork has 1 star and no substantive commits diverging from upstream. It is not a viable alternative and can be disregarded.

**Risk level:** Low. The project has a large enough community that a single maintainer departure would not be catastrophic. Mitigation: pin a specific released binary (not `latest`); update only after validating the new binary on the buildd repo.

### 8.2 License

MIT. Permissive. No copyleft, no attribution requirement in binary output. Compatible with commercial use.

### 8.3 Binary provenance and supply chain

The binary is distributed via GitHub Releases. Upstream provides:
- SHA-256 checksums for all artifacts
- SLSA Level 3 provenance (cryptographic build attestations)
- Sigstore cosign keyless signatures
- VirusTotal scanning (70+ engines) before each release
- Zero transitive runtime dependencies (all libraries vendored at compile time)

**Implementation requirement:** the Dockerfile must verify the SHA256 checksum before making the binary executable (see §2.1 Dockerfile snippet). The checksum must be committed to the image build config and reviewed on each version bump.

**Risk level:** Low given SLSA L3 + checksum verification. Residual risk: the upstream GitHub account or release infrastructure could be compromised. Mitigation: pin to a specific version tag (not `main`); review release notes before bumping.

### 8.4 Multi-tenant isolation

**Risk:** multiple workers in the same Coder environment (same host, different tasks) could interact via the CBM cache if they share a cache root or if `CBM_ALLOWED_ROOT` is misconfigured.

**Mitigations implemented by this spec:**
1. `CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}` — per-worker cache root; no sharing
2. `CBM_ALLOWED_ROOT=<worktreePath>` — restricts CBM to the worker's own worktree
3. bwrap sandbox: CBM cannot access other workers' worktrees or cache dirs (not mounted)
4. No shared cache volume in v1 (§4.2)

**Residual risk:** if `BUILDD_DISABLE_SANDBOX=1` is set (sandbox disabled), the bwrap isolation does not apply. CBM_ALLOWED_ROOT still restricts indexing, but the cache dir would be the sole isolation boundary. This is acceptable in non-sandboxed environments where other isolation exists at the VM/container level.

### 8.5 Cloudflare / GitHub Actions runner substrate

CBM is a single static binary with no daemon requirement in CLI mode. In GitHub Actions runners (used for CI integration tests), CBM can run in CLI mode (`codebase-memory-mcp cli index_repository ...`) without the coordination daemon. No persistent state is needed across CI steps.

Cloudflare Workers cannot run arbitrary binaries. If a future architecture runs task coordination on Cloudflare (not currently planned), CBM would need to run on a separate sidecar or be unavailable for that substrate. This is not an immediate concern.

---

## Open Questions

**Q1: Runner MCP lifecycle management.** How does the runner start and manage the CBM stdio subprocess? The SDK supports additional MCP servers via `mcpServers` in query options. Confirm whether the runner injects CBM into the SDK's server list or manages it as a separate process before handing off to the SDK. Lean toward SDK injection (most consistent with how `buildd` MCP is wired).

*Working assumption:* inject via SDK's `mcpServers` option at `query()` call time, same as the buildd connector. The runner sets `CBM_CACHE_DIR` and runs `index_repository` via a one-shot `codebase-memory-mcp cli index_repository <path>` before calling `query()`.

**Q2: `index_repository` path.** Should we index the full monorepo root or just the task's worktree? The worktree is a git worktree of the repo — it contains all files but may share `.git` with the main checkout. CBM uses `.gitignore` for exclusions; indexing the worktree root is equivalent to indexing the repo for files present in the worktree.

*Working assumption:* index the worktree path (`sessionCwd`), not the shared repo root. This scopes the index to the worker's actual workspace.

**Q3: env var injection for `CBM_CACHE_DIR`** at runner level. The mcpServers env config in the role record uses a literal string. The runner must substitute `${WORKER_ID}` at spawn time. Does this follow an existing substitution pattern in `workers.ts`, or does it need a new one?

*Working assumption:* add a new substitution for `__WORKER_ID__` (following the `__WORKSPACE_DIR__` convention) in the MCP env resolution step.

---

## Non-Goals

- Changes to `spec_compare` (vocabulary gap grounding is a future enhancement, §6.3)
- Shared CBM cache volume across workers (deferred, §4.2)
- Exposing `manage_adr` or `ingest_traces` to workers (blocked, §2.4)
- Replacing the SCIP-based offline knowledge graph plan (`knowledge-graph-retrieval.md`) — that serves a different purpose
- Running CBM on Cloudflare Workers (not an immediate concern, §8.5)
- Dashboard UI for graph results (workers consume graph data; no user-facing graph visualization in v1)

---

## Implementation Task Breakdown

The following tasks are proposed for the implementation phase. They are NOT filed — human approval of this spec is required first.

### Task 1: Image build — pin and verify CBM binary
**Scope:** Coder worker image Dockerfile
**Work:** Add `ARG CBM_VERSION`, `ARG CBM_SHA256`; `curl` the binary, verify SHA256, `chmod +x`. Run `codebase-memory-mcp --version` as a smoke test in the build step.
**Deliverable:** Updated Dockerfile committed to the image build repo; CI build passes.

### Task 2: Runner — bootstrap integration (index_repository + timeout/fallback)
**Scope:** `apps/runner/src/workers.ts`
**Work:**
- Detect when role has `mcpServers["codebase-memory"]`
- Set `CBM_CACHE_DIR=/tmp/cbm-${WORKER_ID}` in env
- Before `query()`: run one-shot `codebase-memory-mcp cli index_repository <sessionCwd>` with 30s timeout
- On timeout: log + emit `graph_index_timeout` event; proceed without CBM in server list
- On success: add CBM to the SDK's `mcpServers` option for the `query()` call
**Deliverable:** PR targeting `dev`; unit tests for timeout path.

### Task 3: Mount allowlist — CBM binary and cache dir
**Scope:** `apps/runner/src/worker-bwrap.ts` (or equivalent)
**Work:** When role has `codebase-memory` in mcpServers, extend `buildWorkerMountAllowlist` to include `/opt/buildd/bin/codebase-memory-mcp:ro` and `/tmp/cbm-${WORKER_ID}:rw`.
**Deliverable:** PR targeting `dev`; sandbox test that CBM binary is accessible inside bwrap.

### Task 4: Measure index performance on buildd repo
**Scope:** Coder environment (one-off measurement)
**Work:** Run `time codebase-memory-mcp cli index_repository /home/coder/project/buildd` with `CBM_MEM_BUDGET_MB=512`, record wall-clock and peak RSS. Update §5.2 of this spec with real numbers.
**Deliverable:** Measurement artifact attached to this task; spec updated.

### Task 5: Role update — Builder role pilot opt-in
**Scope:** `apps/web/src/lib/default-roles.ts` or via `buildd action=update_skill`
**Work:** Add `codebase-memory` to Builder role's `mcpServers`; add 12 CBM tool names to `allowedTools`.
**Deliverable:** PR targeting `dev` or skill API call; Builder role config updated in DB.

### Task 6: env var substitution — `__WORKER_ID__` in MCP env config
**Scope:** `apps/runner/src/workers.ts` (MCP env resolution step)
**Work:** Add substitution for `__WORKER_ID__` alongside any existing substitution patterns; write unit test.
**Deliverable:** PR targeting `dev`.

### Task 7: Observability — track CBM tool calls in task metrics
**Scope:** `apps/runner/src/workers.ts` (tool call scanner or `scanToolResult`)
**Work:** Detect `mcp__codebase-memory__*` tool calls in worker output; count and emit in `update_progress` alongside `inputTokens`/`outputTokens`. This provides the data for success metric tracking (§7).
**Deliverable:** PR targeting `dev`.

### Task 8 (deferred): spec_compare graph-grounding bridge
**Scope:** `packages/core/mcp-tools.ts` (`spec_compare` / `extractImplementationAnchors`)
**Dependency:** Tasks 1–5 complete and pilot metrics show positive results.
**Work:** When CBM is available in the worker context, augment `extractImplementationAnchors` to call `search_graph` for each candidate anchor and use canonical symbol names in the code query (§6.2).
**Deliverable:** PR targeting `dev`; regression test confirming renamed symbols are still found.

---

*End of spec. Requires human approval before any implementation task is filed.*
