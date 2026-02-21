# Claude Agent SDK Ecosystem Research

> Last updated: 2026-02-21
> Purpose: Track how the community uses the Claude Agent SDK and identify features/patterns Buildd should adopt.

## Community Projects Using the SDK

### 1. Agentic Coding Flywheel Setup (Dicklesworthstone)
**What**: Bootstraps a fresh Ubuntu VPS into a complete multi-agent AI dev environment in 30 minutes.
**SDK Features Used**: Multi-agent coordination, Agent Mail MCP server for cross-agent work, advisory file reservations (leases) to prevent agent conflicts, persistent artifacts in git.
**Takeaway for Buildd**: Their Agent Mail MCP concept (inter-agent messaging via file-based leases) is interesting — Buildd already has a richer coordination model, but the "advisory file reservations" pattern could prevent workers from clobbering each other on shared repos.

---

## Deep Dive: Agentic Coding Flywheel Setup (ACFS)

> Sources: [agentic_coding_flywheel_setup](https://github.com/Dicklesworthstone/agentic_coding_flywheel_setup), [mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail), [ntm](https://github.com/Dicklesworthstone/ntm), [agent-flywheel.com](https://agent-flywheel.com/tldr)

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ACFS — Ubuntu VPS Environment                     │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                   NTM (Named Tmux Manager)                   │    │
│  │              "Agent Cockpit" — orchestration layer            │    │
│  │                                                               │    │
│  │   ┌──────────┐   ┌──────────┐   ┌──────────┐                │    │
│  │   │ cc_1     │   │ cod_1    │   │ gmi_1    │   ← tmux panes │    │
│  │   │ Claude   │   │ Codex    │   │ Gemini   │                 │    │
│  │   │ Code     │   │ CLI      │   │ CLI      │                 │    │
│  │   └────┬─────┘   └────┬─────┘   └────┬─────┘                │    │
│  │        │              │              │                        │    │
│  │        └──────────────┼──────────────┘                        │    │
│  │                       │                                       │    │
│  │              ┌────────▼────────┐                              │    │
│  │              │  ntm send/      │   broadcast, per-type send,  │    │
│  │              │  ntm broadcast  │   interrupt, copy, dashboard  │    │
│  │              └────────┬────────┘                              │    │
│  └───────────────────────┼──────────────────────────────────────┘    │
│                          │                                           │
│  ┌───────────────────────▼──────────────────────────────────────┐   │
│  │            MCP Agent Mail (HTTP :8765)                        │   │
│  │         "Gmail for AI coding agents"                          │   │
│  │                                                               │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │   │
│  │  │  Identities  │  │  Messaging   │  │ File Reservations  │  │   │
│  │  │  register    │  │  send/fetch  │  │  reserve/release   │  │   │
│  │  │  discover    │  │  threads     │  │  TTL + staleness   │  │   │
│  │  │  profiles    │  │  search FTS5 │  │  pre-commit guard  │  │   │
│  │  └──────┬──────┘  └──────┬───────┘  └────────┬───────────┘  │   │
│  │         └────────────────┼────────────────────┘              │   │
│  │                          │                                    │   │
│  │              ┌───────────▼───────────┐                       │   │
│  │              │   Dual Persistence    │                       │   │
│  │              │  SQLite (FTS5 index)  │                       │   │
│  │              │  Git (audit trail)    │                       │   │
│  │              └───────────────────────┘                       │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌─────────────────────────────────────┐                            │
│  │        Intelligence Layer           │                            │
│  │  CASS → CM → BV                    │                            │
│  │  (search) (memory) (task graph)    │                            │
│  │                                     │                            │
│  │  Episodic → Working → Procedural   │  ← 3-tier memory system   │
│  │  (raw sessions) (diary) (playbook) │    90-day decay, 4× harm  │
│  └─────────────────────────────────────┘                            │
│                                                                      │
│  ┌─────────────────────────────────────┐                            │
│  │        Safety Layer                 │                            │
│  │  SLB: two-person approval rule     │                            │
│  │  DCG: pre-execution command guard  │                            │
│  │  CAAM: sub-100ms auth switching    │                            │
│  └─────────────────────────────────────┘                            │
└─────────────────────────────────────────────────────────────────────┘
```

### 1. Agent Mail MCP Server — Deep Technical Analysis

**Repository**: [Dicklesworthstone/mcp_agent_mail](https://github.com/Dicklesworthstone/mcp_agent_mail)
**Stack**: Python, FastMCP (HTTP, not STDIO), SQLModel + SQLite FTS5, Git

#### Messaging Model: Point-to-Point with Threads

Agent Mail is **not** pub/sub or broadcast. It explicitly rejects broadcast patterns:

```python
def _looks_like_broadcast(value: str) -> bool:
    v = value.lower().strip()
    return v in {"all", "*", "everyone", "broadcast", "@all", "@everyone"}
# Returns error: "Agent Mail doesn't support broadcasting to all agents.
# List specific recipient agent names in the 'to' parameter."
```

Messages are **point-to-point** with explicit addressing (To/Cc/Bcc), organized into **searchable threads**. Each message is a GFM-Markdown file with JSON frontmatter:

```
---json
{"sender": "GreenCastle", "to": ["BlueMountain"], "thread_id": "...", ...}
---

Body content in GitHub-Flavored Markdown
```

**Storage is triple-copied** for each message:
- `messages/{YYYY}/{MM}/{ISO}__{slug}__{id}.md` — canonical
- `agents/{sender}/outbox/{YYYY}/{MM}/{file}.md` — sender's outbox
- `agents/{recipient}/inbox/{YYYY}/{MM}/{file}.md` — each recipient's inbox

#### Agent Discovery

Agents register with memorable adjective+noun names (e.g., "GreenCastle") scoped to a project:

```python
# Registration
ensure_project(project_key="/abs/path/to/repo")
register_agent(project_key, name="GreenCastle", program="claude-code", model="opus-4")

# Discovery
list_agents(project_key)       # LDAP-style directory listing
get_directory(project_key)     # Full agent profiles + activity status
```

Project identity resolution works across worktrees via git-remote fingerprinting, git-common-dir hashing, or canonical path — ensuring the same project is recognized regardless of worktree location.

#### Message Schema (SQLModel)

```python
class Message(SQLModel, table=True):
    id: int (PK)
    project_id: int (FK → projects)
    sender_id: int (FK → agents)
    thread_id: Optional[str]       # conversation grouping
    topic: Optional[str]           # category tag
    subject: str                   # max 512 chars
    body_md: str                   # GFM body
    importance: str = "normal"     # normal | high | urgent
    ack_required: bool = False     # request read receipt
    created_ts: datetime
    attachments: list[dict] (JSON) # WebP or data URIs
```

#### MCP Tools Exposed

| Cluster | Tools |
|---------|-------|
| Identity | `ensure_project`, `register_agent`, `list_agents`, `get_directory` |
| Messaging | `send_message`, `fetch_inbox`, `acknowledge_message`, `search_messages`, `get_thread` |
| File Reservations | `file_reservation_paths`, `release_file_reservations`, `force_release_file_reservation` |
| Contacts | `request_contact`, `respond_contact` |
| Macros | `macro_start_session`, `macro_prepare_thread`, `macro_file_reservation_cycle`, `macro_contact_handshake` |
| Resources | `resource://inbox/{agent}`, `resource://thread/{id}` |

#### Comparison: Agent Mail vs Buildd Coordination

| Dimension | Agent Mail | Buildd |
|-----------|-----------|--------|
| **Communication** | Point-to-point messaging (MCP tools) | Pusher realtime events + MCP `buildd` tool |
| **Persistence** | SQLite FTS5 + Git dual store | Postgres (Neon) + Pusher ephemeral |
| **Agent Discovery** | Project-scoped registry + LDAP-style query | Workers auto-registered via claim API |
| **Work Distribution** | Manual via messages ("please work on X") | Task queue + atomic claim (`POST /api/workers/claim`) |
| **File Conflict Prevention** | Advisory file reservations with TTL | None (worktree isolation assumed) |
| **Audit Trail** | Git commits per message/reservation | Database records + worker progress updates |
| **Topology** | Peer-to-peer (no central orchestrator) | Hub-and-spoke (API server coordinates) |
| **Session State** | Persistent across disconnects (tmux + git) | Session resume via SDK `sessionId` |
| **Search** | FTS5 BM25 scoring across all messages | `buildd_memory` search with keyword/concept filters |

### 2. Advisory File Reservations — Implementation Details

#### How Leases Work

**Schema:**
```python
class FileReservation(SQLModel, table=True):
    id: int (PK)
    project_id: int (FK → projects)
    agent_id: int (FK → agents)
    path_pattern: str              # file path or glob ("src/**/*.ts")
    exclusive: bool = True         # exclusive vs shared mode
    reason: str                    # why agent needs this file
    created_ts: datetime
    expires_ts: datetime           # TTL-based auto-expiry (default 3600s)
    released_ts: Optional[datetime] # explicit release timestamp
```

**Granularity**: File-level paths AND glob patterns (e.g., `src/**`, `frontend/**/*.tsx`). Virtual namespaces (`tool://`, `resource://`, `service://`) are also supported for non-file resources.

**Lifecycle:**
1. **Acquire**: `file_reservation_paths(project_key, agent_name, ["src/api/**"], ttl_seconds=3600, exclusive=true, reason="Refactoring API layer")`
2. **Conflict check**: If another agent holds an exclusive reservation on overlapping paths, the request is denied at the MCP layer (before any edit attempt).
3. **Work**: Agent edits files freely within reserved paths.
4. **Release**: Explicit `release_file_reservations()` call, or auto-expiry after TTL.
5. **Force release**: Other agents can `force_release_file_reservation()` if staleness heuristics indicate abandonment. The previous holder is notified.

**Staleness Heuristics** — Four activity dimensions tracked:

```python
@dataclass
class FileReservationStatus:
    reservation: FileReservation
    agent: Agent
    stale: bool
    stale_reasons: list[str]
    last_agent_activity: Optional[datetime]   # last MCP tool call
    last_mail_activity: Optional[datetime]    # last message ack
    last_fs_activity: Optional[datetime]      # file mtime on reserved paths
    last_git_activity: Optional[datetime]     # last commit touching reserved paths
```

A reservation is marked stale when all four signals go silent — the agent hasn't called tools, hasn't sent/ack'd messages, hasn't modified files, and hasn't committed to git. `_max_datetime()` picks the most recent signal.

**Pre-commit Guard**: Installs a git hook at `hooks.d/pre-commit/50-agent-mail.py` that:
1. Reads `AGENT_NAME` from environment
2. Loads all active reservations from `file_reservations/*.json`
3. Compiles glob patterns via `pathspec` library (fallback to `fnmatch`)
4. Checks each staged file against reservation patterns
5. Skips reservations held by the current agent (self-reservation allowed)
6. **Blocks commit** if staged files overlap with another agent's exclusive reservation
7. Mode controlled by `AGENT_MAIL_GUARD_MODE` (block vs warn); bypass with `AGENT_MAIL_BYPASS=1`

**Git artifact format** for reservations:
```
file_reservations/
├── id-{reservation_id}.json    # stable ID-based (current)
└── {sha1_digest}.json          # legacy path-digest (deprecated)
```

### 3. Multi-Agent Coordination Model

#### ACFS: Peer Coordination via Shared Infrastructure

ACFS uses a **decentralized peer model** — there is no central orchestrator. Instead, coordination emerges from shared infrastructure:

| Layer | Tool | Role |
|-------|------|------|
| Session Management | NTM | Spawn/tile/monitor agent panes in tmux |
| Communication | Agent Mail | Point-to-point messaging + file leases |
| Task Intelligence | Beads Viewer | PageRank + betweenness centrality on task graph |
| Cross-Session Memory | CASS + CM | Search sessions → episodic → working → procedural memory |
| Safety | SLB + DCG | Two-person approval + pre-execution blocking |

**NTM Orchestration**: Human operator dispatches work via:
```bash
ntm spawn myproject --cc=3 --cod=2 --gmi=1   # 3 Claude, 2 Codex, 1 Gemini
ntm send myproject --cc "fix TypeScript errors" # send to all Claude agents
ntm send myproject --all "explain your approach" # broadcast to all agents
ntm interrupt myproject                          # Ctrl+C all agents
ntm dashboard myproject                          # live monitoring UI
```

**Agent roles are type-based**, not hierarchical:
- **Claude Code** (`--cc`): Architecture, planning, complex reasoning
- **Codex CLI** (`--cod`): Implementation, code generation
- **Gemini CLI** (`--gmi`): Testing, validation, alternative perspectives

**vs Buildd's model**: Buildd uses a **centralized task queue** where the API server is the coordinator:
1. Tasks created (dashboard/API) → stored in Postgres
2. Workers call `POST /api/workers/claim` with atomic `UPDATE...WHERE` for optimistic locking
3. Workers report progress via `PATCH /api/workers/[id]`
4. Results pushed via Pusher realtime events

**Key difference**: ACFS coordinates via shared communication infrastructure (agents message each other). Buildd coordinates via shared work infrastructure (API assigns tasks to agents). ACFS is more flexible for exploratory work; Buildd is more structured for production task execution.

### 4. Bootstrap Architecture

**Installation model**: Single bash script (`install.sh`) bootstrapping 50+ modules in 10 phases:

```
Phase 1-3: Foundation (apt packages, user setup, filesystem: /data/projects)
Phase 4:   Shell (zsh, oh-my-zsh, powerlevel10k, plugins)
Phase 5:   CLI tools (ripgrep, tmux, fzf, bat, lazygit, tailscale)
Phase 6:   Runtimes (bun, uv/python, rust-nightly, go, node/nvm)
Phase 7:   Coding agents (claude-code, codex-cli, gemini-cli)
Phase 8:   Cloud/DB (optional: vault, postgresql, wrangler, supabase)
Phase 9:   Stack tools (ntm, agent-mail, cass, cm, bv, dcg, slb, caam)
Phase 10:  Finalization (workspace, onboarding TUI, health checks, auto-updates)
```

**Manifest-driven**: `acfs.manifest.yaml` is the single source of truth. A TypeScript parser with Zod validation generates the installer. Each module declares dependencies; topological sort determines execution order.

**State management**: `~/.acfs/state.json` tracks installation progress for idempotent resume after disconnection. Nightly auto-updates keep tools current.

**Agent topology**: No fixed agent count — the operator decides at spawn time. Typical configurations:
- Solo: 1 Claude Code agent
- Team: 3 Claude + 2 Codex + 1 Gemini (6 agents)
- Swarm: Scale up to rate-limit boundaries, using CAAM for sub-100ms auth switching

### 5. Git Artifact Persistence

ACFS uses git for three distinct persistence layers:

1. **Agent Mail archive**: All messages, file reservations, and agent profiles committed to a shared git repo with `Agent: {name}` trailers. Commits batched via async queue with exponential backoff on index.lock contention.

2. **Beads (task tracking)**: Work items tracked in `.beads/` directory. Commit pattern: `git pull --rebase && git add .beads/ && git commit -m "Update beads" && git push`. Not complete until push succeeds.

3. **Session artifacts**: CASS indexes all agent session transcripts into a Tantivy search index. CM transforms raw sessions through a 3-tier pipeline:
   - **Episodic** (raw sessions) → **Working** (diary-style summaries) → **Procedural** (playbook rules with 90-day decay half-life, 4× weight for harmful mistakes)

**Agent Mail commit strategy**: Uses `AsyncFileLock` per project at `projects/{slug}/.commit.lock`. The commit queue batches non-conflicting paths into single commits. LRU cache (max 16) manages `git.Repo` objects to prevent file descriptor leaks.

---

### Comparison Table: ACFS vs Buildd

| Aspect | ACFS | Buildd | Winner |
|--------|------|--------|--------|
| **Deployment** | Single VPS, bash installer | Vercel (API) + remote workers | ACFS simpler; Buildd more scalable |
| **Agent types** | Claude Code + Codex + Gemini | Claude Code only (via SDK) | ACFS more diverse |
| **Orchestration** | Peer coordination via NTM + Agent Mail | Centralized task queue + atomic claim | Buildd more deterministic |
| **File conflicts** | Advisory leases + pre-commit guard | Worktree isolation (no lease system) | ACFS more granular for shared repos |
| **Communication** | Async point-to-point messaging | Realtime Pusher + MCP status updates | Different tradeoffs |
| **Persistence** | Git + SQLite (local, human-auditable) | Postgres (Neon, cloud-native) | Buildd more durable |
| **Memory** | 3-tier: episodic → working → procedural | Flat workspace memory (buildd_memory) | ACFS more sophisticated |
| **Safety** | SLB (two-person rule) + DCG (command guard) | Budget limits + abort controller | ACFS more layered |
| **Search** | Tantivy FTS (sub-second) + SQLite FTS5 | buildd_memory keyword/concept search | ACFS more powerful |
| **Cost management** | CAAM auth switching across providers | Per-worker budgets, per-model tracking | Buildd more precise |
| **Observability** | NTM dashboard + Beads Viewer | Web dashboard + Pusher realtime | Similar capabilities |

---

### Implementation Spec: Advisory File Reservations for Buildd

#### Motivation

When multiple Buildd workers operate on the same repository (e.g., shared monorepo without worktree isolation), they can clobber each other's edits. ACFS solves this with advisory file reservations — a pattern worth adopting.

#### Database Table Design

```sql
CREATE TABLE file_reservations (
  id            TEXT PRIMARY KEY DEFAULT (gen_random_uuid()),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  worker_id     TEXT NOT NULL REFERENCES workers(id),
  task_id       TEXT NOT NULL REFERENCES tasks(id),
  path_pattern  TEXT NOT NULL,            -- file path or glob ("src/api/**")
  exclusive     BOOLEAN NOT NULL DEFAULT TRUE,
  reason        TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,     -- created_at + ttl
  released_at   TIMESTAMPTZ,             -- NULL = active
  CONSTRAINT valid_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idx_file_res_workspace ON file_reservations(workspace_id)
  WHERE released_at IS NULL AND expires_at > NOW();
CREATE INDEX idx_file_res_worker ON file_reservations(worker_id);
```

#### Drizzle Schema (packages/core/db/schema.ts)

```typescript
export const fileReservations = pgTable('file_reservations', {
  id: text('id').primaryKey().$defaultFn(() => createId()),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  workerId: text('worker_id').notNull().references(() => workers.id),
  taskId: text('task_id').notNull().references(() => tasks.id),
  pathPattern: text('path_pattern').notNull(),
  exclusive: boolean('exclusive').notNull().default(true),
  reason: text('reason').default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
});
```

#### PreToolUse Hook Implementation

In `worker-runner.ts`, add a PreToolUse hook that intercepts Write/Edit operations:

```typescript
// In the hooks configuration for the SDK query
{
  type: 'preToolUse',
  toolName: ['Write', 'Edit', 'NotebookEdit'],
  async handler({ toolInput, session }) {
    const filePath = toolInput.file_path || toolInput.notebook_path;
    if (!filePath) return { decision: 'approve' };

    // Normalize to repo-relative path
    const repoRelative = path.relative(session.cwd, filePath);

    // Check for conflicting reservations
    const conflicts = await db.select()
      .from(fileReservations)
      .where(and(
        eq(fileReservations.workspaceId, workspaceId),
        isNull(fileReservations.releasedAt),
        gt(fileReservations.expiresAt, new Date()),
        eq(fileReservations.exclusive, true),
        ne(fileReservations.workerId, currentWorkerId),
        // pathMatchesGlob is checked in application code
      ));

    const blocking = conflicts.filter(r =>
      minimatch(repoRelative, r.pathPattern)
    );

    if (blocking.length > 0) {
      const holder = blocking[0];
      return {
        decision: 'block',
        message: `File "${repoRelative}" is reserved by worker ${holder.workerId} ` +
                 `(reason: ${holder.reason}). Reservation expires at ${holder.expiresAt}.`
      };
    }

    return { decision: 'approve' };
  }
}
```

#### MCP Tool for Workers

Add to the `buildd` MCP server:

```typescript
// Reserve files before editing
tool('reserve_files', {
  params: {
    paths: z.array(z.string()),          // file paths or globs
    ttlSeconds: z.number().default(3600),
    exclusive: z.boolean().default(true),
    reason: z.string().optional(),
  },
  async handler({ paths, ttlSeconds, exclusive, reason }) {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    // Check conflicts first, then insert
    // Return { reserved: [...], conflicts: [...] }
  }
});

// Release reservations when done
tool('release_files', {
  params: { paths: z.array(z.string()).optional() },
  async handler({ paths }) {
    // Set released_at = NOW() for matching reservations
  }
});
```

#### Lifecycle Integration

1. **Worker claims task** → auto-reserve files listed in task description (if any)
2. **Worker calls reserve_files** → MCP tool checks conflicts, creates reservation
3. **Worker edits file** → PreToolUse hook verifies reservation, blocks if conflict
4. **Worker completes task** → auto-release all reservations via SessionEnd hook
5. **Worker crashes/times out** → reservations auto-expire via `expires_at` TTL
6. **Dashboard UI** → show active reservations on task detail page

#### Staleness Detection (Inspired by ACFS)

Unlike ACFS's 4-signal heuristic (agent activity, mail, filesystem, git), Buildd can use simpler signals since we already track worker state:

```typescript
function isReservationStale(reservation: FileReservation, worker: Worker): boolean {
  // Worker is no longer active
  if (['completed', 'failed', 'cancelled'].includes(worker.status)) return true;
  // Worker hasn't reported progress in 2× TTL
  if (worker.lastProgressAt < reservation.createdAt - 2 * ttl) return true;
  // Reservation expired
  if (reservation.expiresAt < new Date()) return true;
  return false;
}
```

---

### Assessment: Agent Mail Patterns Worth Adopting

#### Adopt (High Value for Buildd)

1. **Advisory file reservations** — The most valuable pattern. Buildd workers sharing a repo need conflict prevention. The ACFS model (TTL leases + PreToolUse hook + pre-commit guard) maps directly to Buildd's hook system. See implementation spec above.

2. **Project identity resolution across worktrees** — ACFS resolves project identity via git-remote fingerprinting and git-common-dir hashing. Buildd already uses worktree isolation but could benefit from this for workers sharing a base repo.

3. **Commit queue with batching** — ACFS batches non-conflicting Git commits to reduce index.lock contention. Useful if Buildd moves to shared-repo (non-worktree) worker models.

#### Consider (Medium Value)

4. **3-tier memory pipeline** — ACFS's episodic → working → procedural memory with decay half-life is more sophisticated than Buildd's flat `buildd_memory`. Could enhance long-term workspace knowledge if agents work on the same project over weeks/months.

5. **NTM-style dashboard for multi-agent monitoring** — The token velocity badges and conflict tracking in NTM could enhance Buildd's web dashboard for observing concurrent workers.

6. **Staleness heuristics for lease cleanup** — The 4-signal approach (agent, mail, filesystem, git) is thorough but complex. Buildd's worker status tracking provides simpler equivalent signals.

#### Skip (Low Value / Different Architecture)

7. **Point-to-point agent messaging** — Buildd's centralized task queue makes direct agent-to-agent messaging unnecessary. Workers don't need to coordinate peer-to-peer because the API server is the coordinator.

8. **Git-backed message archive** — Buildd uses Postgres for all persistence. Adding a Git archive layer adds complexity without clear benefit given Buildd's cloud-native architecture.

9. **Memorable agent names** — Cute but unnecessary. Buildd workers have UUIDs tied to tasks; human-readable names would add mapping complexity without improving coordination.

10. **Two-person approval (SLB)** — Interesting safety pattern but orthogonal to Buildd's model where workers execute within defined permission boundaries. Better solved by SDK `permissionMode` + plan review.

---

### 2. ClaudeSwarm (simonstaton)
**What**: Self-hosted platform for running coordinated Claude agent swarms with React UI on GCP Cloud Run.
**SDK Features Used**: Express API managing Claude CLI processes, JWT auth, GCS-synced shared context, kill switch.
**Takeaway for Buildd**: Their **kill switch** (POST /api/kill-switch — blocks all API requests, persists to disk + GCS) is worth noting. Buildd's `abortController` approach is per-worker; a global kill switch would add a production safety net. Also validates the "web dashboard + remote workers" architecture that Buildd uses.

### 3. myclaude (cexll)
**What**: Multi-agent orchestration workflow system with intelligent routing.
**SDK Features Used**: 5-phase feature dev workflow (/do command), multi-agent orchestration (/omo), SPARV workflow (Specify→Plan→Act→Review→Vault), 11 core dev commands, task routing to different backends (codex, gemini, claude) with fallback.
**Takeaway for Buildd**: Their **task routing by type** (default→claude, UI→codex, quick-fix→gemini) with fallback prioritization is a pattern Buildd could adopt — route tasks to different models based on task type or complexity.

### 4. agentic-flow (ruvnet)
**What**: Framework to switch between alternative low-cost AI models in Claude Agent SDK.
**SDK Features Used**: Model switching, deployment patterns for hosted agents.
**Takeaway for Buildd**: Validates demand for multi-model support within agent SDK workflows.

### 5. parruda/swarm (Ruby)
**What**: Ruby gems for general-purpose AI agent systems with persistent memory, semantic search, node workflows.
**SDK Features Used**: SwarmMemory for persistent memory with semantic search, hook-based workflows.
**Takeaway for Buildd**: Their persistent memory with semantic search mirrors Buildd's workspace memory (`buildd_memory`). The node-based workflow system is an interesting alternative to Buildd's linear task model.

## Buildd's Current SDK Usage (What We Do Well)

| Feature | Status | Notes |
|---------|--------|-------|
| V1 Query API | Full | Correct choice for orchestration with CLAUDE.md, plugins, sandbox |
| Hooks (10/12) | Extensive | PreToolUse, PostToolUse, PostToolUseFailure, Notification, PermissionRequest, SessionStart, SessionEnd, PreCompact, TeammateIdle, TaskCompleted, SubagentStart, SubagentStop |
| Agent Teams | Full | Skill delegation, subagent lifecycle tracking |
| In-Process MCP | Full | buildd + buildd_memory tools via createSdkMcpServer() |
| Structured Outputs | Basic | JSON schema when task defines outputSchema |
| File Checkpointing | Enabled | enableFileCheckpointing: true |
| Session Resume | Full | Resume with sessionId + streamInput for multi-turn |
| Cost Tracking | Full | Per-worker budgets, per-model usage breakdowns |
| Rate Limit Detection | Full | SDK v0.2.45+ events + fallback detection |

## SDK Features We Don't Yet Use (Opportunities)

### High Priority
1. **`rewindFiles(messageUuid)`** — Checkpointing is enabled but rewind is never invoked. Could power an "undo" button in the dashboard.
2. **`effort` levels** (`low`/`medium`/`high`/`max`) — Could scale worker effort based on task priority. Quick tasks use `low`, critical bugs use `max`.
3. **`fallbackModel`** — Graceful degradation when primary model hits rate limits. Zero cost to implement.
4. **Dynamic Model Switching** (`setModel()`) — Already tested in E2E but not used in production. Could enable mid-session model escalation (start with Sonnet, escalate to Opus for complex reasoning).

### Medium Priority
5. **`canUseTool` function** — Cleaner separation of permission logic from PreToolUse observability hooks.
6. **Dynamic MCP Server Management** (`reconnectMcpServer()`, `toggleMcpServer()`, `setMcpServers()`) — Runtime tool hot-swap, MCP crash recovery.
7. **`thinking` / Extended Reasoning** — `{ type: 'adaptive' }` or `{ type: 'enabled', budgetTokens: N }` for complex architectural tasks.
8. **Plan Mode Review UI** — Currently plans are auto-approved. Could add dashboard step for human review.
9. **`additionalDirectories`** — Workers accessing shared monorepo packages outside CWD.

### New in v0.2.49
14. **`ConfigChange` hook** — Enterprise security auditing of config changes during worker sessions.
15. **Model capability discovery** (`supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking`) — Runtime feature detection instead of hardcoded model assumptions.
16. **Worktree isolation** (`isolation: "worktree"` on agent definitions) — Subagents in isolated worktrees for parallel-safe work.
17. **Sonnet 4.6 1M context** — Sonnet 4.5 1M being removed; update 1M context beta to target Sonnet 4.6.

### Lower Priority
10. **`forkSession`** — A/B testing agent behavior, branching workflows.
11. **`resumeSessionAt`** — Rewind to specific conversation point.
12. **`setPermissionMode()`** — Dynamic permission escalation mid-session.
13. **`promptSuggestion()`** — SDK v0.2.47 feature for requesting prompt suggestions.

## Patterns From the Community Worth Adopting

### 1. Task-Type Routing (from myclaude)
Route tasks to different models based on task metadata:
- Bug fixes → fast model (Haiku/Sonnet)
- Architecture work → deep model (Opus with thinking enabled)
- UI tasks → model with visual capabilities
- Quick fixes → `effort: 'low'`, budget-limited

### 2. Advisory File Reservations (from ACFS)
Prevent multiple concurrent workers from editing the same files. Could implement as a PreToolUse hook that checks a file-lock table before allowing Write/Edit operations on shared paths.

### 3. Global Kill Switch (from ClaudeSwarm)
Complement per-worker abortController with a workspace-level kill switch that immediately cancels all active workers. Useful for runaway cost or safety scenarios.

### 4. Workflow Phases (from myclaude SPARV)
Specify → Plan → Act → Review → Vault — structured workflow phases that map naturally to:
- Specify = task description
- Plan = permissionMode: 'plan'
- Act = permissionMode: 'acceptEdits'
- Review = structured output with review checklist
- Vault = workspace memory save

### 5. Multi-Provider Fallback (from agentic-flow)
Configure fallback chains: Anthropic → Bedrock → Vertex. SDK supports multi-provider auth natively.

