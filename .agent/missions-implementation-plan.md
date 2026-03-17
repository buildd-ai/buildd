# Missions Redesign — Implementation Plan

**Date:** 2026-03-15
**Status:** Draft — awaiting review

---

## The Big Picture

Buildd today has 32 pages, 100+ API endpoints, and a runner with its own web UI. The missions redesign isn't a reskin — it's a **simplification**. We're collapsing a data-type navigation (Objectives / Schedules / Tasks / Workers / Artifacts / Settings) into an outcome-driven one (Home / Missions / You).

### What Changes

```
BEFORE (data-type nav)           AFTER (outcome-driven nav)
─────────────────────────        ──────────────────────────
Dashboard (overview)        →    Home (greeting + right now + activity)
Objectives (list/detail)    →    Missions (Build/Watch/Brief cards)
Schedules (cron list)       →    ⊂ Mission config (frequency tab)
Tasks (grid, 200 items)     →    ⊂ Mission detail (task tree)
Workers (list)              →    ⊂ Removed from nav (agents tab in settings?)
Artifacts (list/detail)     →    ⊂ Mission detail (deliverables section)
Workspaces (list/detail)    →    Settings > Workspaces
Teams (list/detail)         →    Settings > Teams
Settings (big page)         →    You (profile + connections + settings)
Runner UI (separate app)    →    HEADLESS (no user-facing UI)
```

### What Gets Removed

1. **Runner web UI** — No login screen, no worker browser, no environment scan display. Runner becomes a pure daemon: claims tasks, executes, reports back. Users never interact with it directly.

2. **Workers page** — No standalone workers list. Active agents show in Mission detail or Home activity feed. Historical workers are just task history.

3. **Standalone Schedules page** — Folded into Mission configuration. Each Watch/Build mission owns its schedule.

4. **Standalone Objectives page** — Replaced entirely by Missions.

5. **Workspaces as top-level nav** — Moved to Settings. Most users have 1-3 workspaces; it doesn't need prominent nav.

### What Stays

- All API endpoints (backward compatible — existing integrations keep working)
- Task detail page (accessible from Mission detail, just reskinned)
- Artifacts detail (accessible from Mission detail)
- Settings page (reorganized as "You" tab)
- Teams/invitations flow
- Auth flow (signin, device auth)

---

## Architecture Decision: Runner — Headless Default, Debug UI Preserved

**Decision:** Runner defaults to headless daemon. UI kept as opt-in debug tool (`--debug` flag).

The runner UI is valuable for debugging — watching Claude's tool calls live, inspecting message streams, sending manual instructions mid-task. Like Chrome DevTools: always there if you need it, never in the user's face.

```
Runner modes:
├── Default (headless): daemon, no HTTP server, no browser
├── --debug:            starts HTTP server + debug UI (simplified from today's UI)
└── Dashboard:          never links to runner UI (no localUiUrl in heartbeat)
```

**Why headless default:**
- Runner is infrastructure, not a product surface
- Dashboard is the single UI — no split attention
- Works on headless VMs, containers, CI — no browser needed
- `buildd login --device` already handles auth without browser

**What runner keeps (all modes):**
- Task claiming loop
- Claude agent execution
- Heartbeat sending (every 5 min)
- MCP tool call tracking
- Git worktree management
- Environment scan (for capability detection, not display)
- Verification command execution (Ralph loop)
- Input-as-retry: on `AskUserQuestion`, snapshot context + fail worker (dashboard handles response)

**What `--debug` adds:**
- HTTP server on local port
- Simplified debug UI (see Runner UI Simplification below)
- Real-time message stream viewer
- Manual instruction input
- No login screen (requires pre-existing auth via `buildd login`)
- No task creation (use dashboard or API)
- No settings management (use config file or CLI)

### Runner UI Simplification

The current runner UI (5.5K LOC) does too much — login, task creation, settings, workspace management, skill browsing. Most of this belongs in the dashboard. The debug UI should be a **single-purpose tool: observe and intervene on running agents.**

```
Current runner UI (kill)              Debug UI (keep, simplify)
─────────────────────                 ──────────────────────────
✗ Login/setup wizard                  ✓ Worker list (active only)
✗ Task creation modal                 ✓ Live message stream per worker
✗ Settings modal                      ✓ Tool call log (MCP tracking)
✗ Workspace management                ✓ Manual instruction input
✗ Skills browser                      ✓ Abort button
✗ Theme toggle                        ✓ Branch + worktree info
✗ Full navigation sidebar             ✓ Verification output viewer
```

Target: ~1.5K LOC debug UI. Single HTML file + minimal JS. No framework. Reads from existing runner API endpoints. Could be rebuilt from scratch rather than trimming the current UI.

### The `waiting_input` Problem

The current runner holds a Claude Code subprocess alive when the agent asks a question, waiting for the user to pipe input back via the runner UI. This is fragile — the subprocess can die, the runner can restart, or the user takes too long. With headless as default, there's no UI to pipe input through.

**Solution: Input-as-retry (Ralph loop pattern).** Instead of keeping sessions alive for human input:
1. Agent asks a question → runner snapshots context (branch, milestones, question) → worker marked `failed` with `reason=needs_input`
2. Notification fires (Pushover with deep link to dashboard)
3. User responds via dashboard mission detail (not runner UI)
4. Dashboard creates a NEW task with `baseBranch` = worker's branch, `context.userInput` = answer, `parentTaskId` = original task
5. Any runner claims the new task → starts fresh on same branch with full context

This decouples the "input surface" (dashboard/notification) from the "execution surface" (runner). Works across runner restarts, multi-runner setups, and mobile.

**Note:** The `--debug` UI can still show the question for observability, but answering always goes through the dashboard/API path — one input surface, no special cases.

**Migration path:**
- Phase 1: Don't touch runner. Build new missions UI pointing at existing APIs.
- Phase 1.5: Build input-as-retry (prerequisite for headless — replaces `waiting_input` flow).
- Phase 2: Flip runner default to headless. Remove `localUiUrl` from heartbeat. Remove "Open in Runner" links from dashboard.
- Phase 3: Rebuild runner UI as minimal debug tool (~1.5K LOC). Old UI archived, not deleted.

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER EXPERIENCE                              │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────┐               │
│  │   HOME   │    │   MISSIONS   │    │     YOU     │               │
│  │          │    │              │    │             │               │
│  │ Greeting │    │ Build cards  │    │ Profile     │               │
│  │ Right Now│───▶│ Watch cards  │    │ Connections │               │
│  │ Activity │    │ Brief cards  │    │ Workspaces  │               │
│  │          │    │              │    │ Settings    │               │
│  └────┬─────┘    └──────┬───────┘    └─────────────┘               │
│       │                 │                                           │
│       │    ┌────────────▼────────────┐                              │
│       │    │    MISSION DETAIL       │                              │
│       │    │                         │                              │
│       │    │  Status + Progress      │                              │
│       │    │  Connected Services     │                              │
│       │    │  Task Tree (children)   │                              │
│       │    │  Activity Feed          │                              │
│       │    │  Quick Task Input       │                              │
│       └───▶│  Deliverables           │                              │
│            └────────────┬────────────┘                              │
│                         │                                           │
│            ┌────────────▼────────────┐                              │
│            │     TASK DETAIL         │                              │
│            │  (reskinned, same data) │                              │
│            │  Worker output, PR, etc │                              │
│            └─────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
         │                    │                    ▲
         │ reads              │ creates            │ updates
         ▼                    ▼                    │
┌─────────────────────────────────────────────────────────────────────┐
│                         API LAYER                                   │
│                   (unchanged, backward compat)                      │
│                                                                     │
│  GET /api/missions ─── mapped to ──▶ Missions list               │
│  POST /api/missions ── mapped to ──▶ Create Mission              │
│  GET /api/tasks ──────── filtered by ─▶ Mission's task tree        │
│  POST /api/tasks ─────── linked via ──▶ objectiveId                │
│  PATCH /api/workers/[id] ────────────▶ Real-time updates           │
│  POST /api/workers/[id]/respond ────▶ Input-as-retry (new)        │
│  POST /api/workers/heartbeat ────────▶ Runner liveness             │
│  GET /api/cron/schedules ────────────▶ Watch mission triggers      │
│                                                                     │
│  MCP: buildd.create_task, buildd.update_progress,                  │
│       buildd.complete_task, buildd.claim_task                      │
└─────────────────────────────────────────────────────────────────────┘
         ▲                    ▲                    │
         │ claims             │ heartbeat          │ dispatches
         │                    │                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     RUNNER (HEADLESS)                                │
│                                                                     │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────┐       │
│  │ Claim Loop  │──▶│ Claude Agent  │──▶│ Verification Gate │       │
│  │ (poll /claim)│   │ (execute task)│   │ (Ralph Loop)      │       │
│  └─────────────┘   └──────┬───────┘   └────────┬──────────┘       │
│                            │                     │                  │
│                     ┌──────▼───────┐      ┌──────▼──────────┐      │
│                     │ MCP Tracking │      │ Pass? Complete  │      │
│                     │ (tool calls) │      │ Fail? Retry     │      │
│                     └──────┬───────┘      │ (create_task    │      │
│                            │              │  w/ failureCtx) │      │
│                     ┌──────▼───────┐      └─────────────────┘      │
│                     │ Input Gate   │                                │
│                     │ AskQuestion? │                                │
│                     │ → snapshot   │                                │
│                     │ → fail worker│                                │
│                     │ → notify     │                                │
│                     │ (dashboard   │                                │
│                     │  creates     │                                │
│                     │  retry task) │                                │
│                     └──────────────┘                                │
│  ┌─────────────┐                                                   │
│  │ Heartbeat   │  every 5 min, reports liveness                    │
│  │ (no UI URL) │  + activeWorkerCount + environment                │
│  └─────────────┘                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation via Ralph Loop

Each phase broken into tasks, each gated by `verificationCommand`.

### Phase 0: Plan Alignment (human)
- [ ] Review this document
- [ ] Decide on page consolidation
- [ ] Decide warm charcoal design tokens (finalize palette)
- [ ] Approve headless runner direction

### Phase 1: Missions UI (zero schema changes)

**Task 1.1: Design tokens + layout shell**
- Create `apps/web/src/lib/design-tokens.ts` — warm charcoal CSS variables
- Create layout wrapper component with 3-tab nav (Home / Missions / You)
- Gate: `bun test && bun run build`
- Ralph: If build fails, retry with failureContext

**Task 1.2: Home page**
- Greeting + subheading (Fraunces italic)
- Right Now section (active tasks query, flat panel)
- Activity feed (recent worker updates)
- Gate: `bun test && bun run build`

**Task 1.3: Mission cards**
- Build card (progress bar + %)
- Watch card (signals count + flagged badge)
- Brief card (finding/artifact inline)
- Left border type indicator
- Fetch from `GET /api/missions` + map to types
- Gate: `bun test && bun run build`

**Task 1.4: Mission detail page**
- Status block + connected services (MCP pills)
- Task tree (children of this objective)
- Scoped activity feed
- Quick task input
- Gate: `bun test && bun run build`

**Task 1.5: Mission creation flow**
- Opinionated: name → type → workspace → done
- Auto-configure frequency based on type:
  - Build: no schedule (manual or one-shot)
  - Watch: every 6h default, adjustable
  - Brief: one-shot or weekly
- Creates objective + schedule via existing APIs
- Gate: `bun test && bun run build`

**Task 1.6: "You" tab**

The "You" tab consolidates team, runners, connections, and API keys onto one screen. Currently these are scattered across Settings, Workspaces, and Accounts pages — confusing for new users and especially for onboarding teammates.

Layout:
```
You
├── Profile
│   ├── Name, avatar, email
│   └── Sign out
│
├── Your Team
│   ├── Max (owner)          [you]
│   ├── Alice (admin)        [invited 2d ago, accepted]
│   └── + Invite someone
│   Note: Teams are independent of GitHub orgs. Anyone with an
│   email can be invited. Role controls: owner > admin > member.
│
├── Runners
│   ├── ● max-macbook         2/3 active    (heartbeat 1m ago)
│   ├── ● coder-vps           0/5 idle      (heartbeat 3m ago)
│   └── ○ alice-laptop        offline       (last seen 2h ago)
│   Shows all runners via workerHeartbeats. Green dot = active,
│   gray = offline. Each shows activeWorkerCount / maxConcurrent.
│
├── Connections
│   ├── GitHub ✓  (buildd-ai org)
│   ├── Dispatch ✓
│   ├── Pushover ✓
│   └── + Connect service
│   Derived from workspace githubInstallations + account MCP config.
│
└── API Keys
    ├── bld_abc...xxxx  (max, admin)     [created 30d ago]
    ├── bld_xyz...xxxx  (alice, worker)  [created 2d ago]
    └── + Create key
    Each key scoped to team. Shows account name, level, age.
    Server-managed secrets (Claude tokens) shown as "● Secret attached"
    without exposing the value.
```

Data sources:
- Profile: `getCurrentUser()` session
- Team + members: `GET /api/teams/[id]` (includes members + invitations)
- Runners: `GET /api/workers/active` (workerHeartbeats, already returns runner instances)
- Connections: workspace `githubInstallationId` + account environment scan
- API Keys: `GET /api/accounts` filtered by team
- Secrets: `GET /api/secrets?teamId=X` (metadata only, never plaintext)

Key UX decisions:
- Team and runners visible together — makes it obvious that inviting someone + them running a runner = more capacity
- API keys shown with human-readable names, not just prefixes
- "Invite someone" is a prominent action, not buried in settings
- Runner status replaces the old "Open in Runner" links — you see health at a glance

- Gate: `bun test && bun run build`

### Phase 2: Input-as-Retry + Runner Simplification

**Task 2.0: Input-as-retry pattern (prerequisite for headless)**

This replaces the fragile `waiting_input` ↔ runner UI ↔ subprocess stdin pipe with the Ralph loop pattern. Three components:

*2.0a: Runner — snapshot + fail on AskUserQuestion*
- When `AskUserQuestion` tool call detected, instead of blocking subprocess:
  - Persist question text + options in worker update (`waitingFor` field — already synced to server)
  - Persist branch name, milestones, current action in worker record
  - Abort the Claude Code subprocess gracefully (SIGTERM or let stale detection handle it)
  - Mark worker as `failed` with `failReason: 'needs_input'` (new field, or use existing `waitingFor` as signal)
- The notification path already fires on `waiting_input` status — keep that, it sends the Pushover alert
- Gate: `cd apps/runner && bun test`

*2.0b: API — `POST /api/workers/[id]/respond` endpoint*
- Auth: session or API key (same as worker PATCH)
- Body: `{ message: string }` — the user's answer
- Logic:
  1. Load the worker + its task (verify status is `failed` or `waiting_input` with `waitingFor` set)
  2. Load the worker's branch, milestones summary, question asked
  3. Create a NEW task:
     - `title`: original task title (or "Continue: <title>")
     - `description`: structured prompt including: original description, what the agent did (milestones), the question asked, the user's answer
     - `parentTaskId`: original task ID
     - `objectiveId`: inherited from original task
     - `workspaceId`: inherited
     - `context.baseBranch`: worker's branch (preserves all work)
     - `context.userInput`: the message
     - `context.previousAttempt`: { question, milestones, branch, workerId }
     - `context.iteration`: N+1
  4. Mark original worker as `completed` (or new status `superseded`) to clean up
  5. Return `{ taskId, workerId? }` — the new task (claimed immediately if runner has capacity)
- Gate: `bun test apps/web/src/app/api/workers/`

*2.0c: Dashboard — respond UI in mission detail*
- In mission detail task list: tasks with `waiting_input` status show inline question (coral dot, like coastal prototype)
- Below the question: text input + send button (reuse quick input pattern)
- Submitting calls `POST /api/workers/[id]/respond`
- After submit: old task shows "superseded", new task appears in list
- Pushover notification includes deep link: `https://buildd.dev/app/missions/{objectiveId}?respond={workerId}`
- Gate: `bun test && bun run build`

**Task 2.1: Flip runner to headless default**
- Default: no HTTP server, no browser auto-open
- `--debug` flag starts HTTP server + serves debug UI
- Remove `localUiUrl` from heartbeat payload (headless mode)
- `--debug` mode still sends `localUiUrl` for local dev
- `buildd login --device` becomes the documented auth path
- Config changes via `~/.buildd/config.json` or env vars, not UI
- Gate: `cd apps/runner && bun test`

**Task 2.2: Remove runner UI references from dashboard**
- Remove "Open in Runner" links from task detail, workspace runners
- Remove runner URL display in workspace detail
- Runner health moves to "You" tab (Runners section — heartbeat-based, no UI link)
- Gate: `bun test && bun run build`

**Task 2.3: Rebuild debug UI (minimal)**
- Single `debug.html` file (~1.5K LOC target)
- No login screen, no task creation, no settings, no nav
- Just: active worker list, live message stream, tool call log, manual instruction input, abort, branch info, verification output
- Reads from existing runner API endpoints (`/api/workers/*`)
- No framework — vanilla HTML/JS, warm charcoal design tokens
- Gate: `cd apps/runner && bun test`

### Phase 3: Orchestrator Skill

**Task 3.1: Mission orchestrator skill**
- Recurring task (runs every hour via schedule)
- Checks all active missions for stale tasks
- Creates follow-up tasks for stalled Build missions
- Fires Watch missions if overdue
- Gate: `bun test && bun run build`

---

## Multi-Agent Strategy

For Phase 1, we can parallelize:

```
Agent A (Task 1.1 + 1.2): Design tokens + Home page
Agent B (Task 1.3 + 1.4): Mission cards + detail page
Agent C (Task 1.5 + 1.6): Creation flow + You tab
```

Each agent:
1. Claims task from buildd
2. Works in git worktree (isolated branch)
3. Ralph loop verifies (`bun test && bun run build`)
4. If fail → auto-retry with failure context
5. If pass → PR created, merge to dev

After all 3 merge:
- Integration test pass
- Manual review of warm charcoal implementation
- Release to production

---

## Page Count: Before vs After

```
BEFORE: 32 pages                 AFTER: ~18 pages
───────────────────              ──────────────────
Dashboard           ×1    →     Home               ×1
Objectives     list ×1    →     Missions      list ×1
Objectives   detail ×1    →     Missions    detail ×1
Schedules           ×1    →     (folded into missions)
Tasks          list ×1    →     (parked — not in nav, revisit later)
Tasks        detail ×1    →     Task detail        ×1  (reskinned)
Tasks           new ×1    →     (folded into mission creation)
Workers        list ×1    →     (removed)
Artifacts      list ×1    →     (folded into missions)
Artifacts    detail ×1    →     Artifact detail    ×1
Workspaces     list ×1    →     (moved to You)
Workspaces   detail ×1    →     Workspace detail   ×1
Workspaces  config+ ×6    →     (simplified, 2-3)
Teams        pages  ×4    →     Teams              ×3  (unchanged)
Accounts            ×1    →     (folded into You)
Settings            ×1    →     You                ×1
Auth           flow ×3    →     Auth               ×3  (unchanged)
Share               ×1    →     Share              ×1  (unchanged)
Dev/fixtures        ×1    →     Dev/fixtures       ×1
Runner UI           ×1    →     (removed)
```

14 pages removed or folded. Net: fewer routes, fewer components, less surface area.

---

## Risk: Backward Compatibility

The existing API is used by:
1. Runner (claims, heartbeats, worker updates)
2. MCP server (Claude Code integration)
3. GitHub webhook
4. Cron trigger (schedules)
5. Any external integrations via API keys

**None of these change.** The redesign is purely a new UI layer reading from the same APIs. Old routes can stay alive behind the new nav — just not linked. If someone bookmarked `/app/objectives/abc123`, we redirect to `/app/missions/abc123`.

---

## Open Questions

1. **Timeline?** Phase 1 could ship in 3-5 days with 3 parallel agents + Ralph loop gates.

## Resolved Questions

1. **How does `waiting_input` work without runner UI?** → Input-as-retry pattern (Task 2.0). Agent question triggers a worker failure + notification. User responds via dashboard. System creates a retry task on the same branch with the answer baked in. No subprocess piping, no runner UI needed. Works across runner restarts, multi-runner setups, and mobile.

2. **Can multiple people run workloads?** → Yes, already supported. Invite via `POST /api/teams/{id}/invitations`, create them an account (`bld_xxx` key), optionally store their Claude credentials as server-managed secrets (AES-256-GCM encrypted, inlined in claim response). They run their own runner instance — or share yours on a different port. The input-as-retry pattern means their runner can pick up tasks that *your* agent asked questions about, and vice versa.

3. **Task grid?** → Parked. Current grid doesn't deliver clear outcomes per task. May revisit as vertical layout with outcome summaries later. Not in nav for now.

4. **Workspace scoping in missions?** → Cross-workspace. Missions dashboard aggregates all workspaces. The orchestrator runs in a dedicated `buildd` meta-workspace (owns no code repos) and creates tasks into the appropriate target workspace. This solves the "where does the orchestrator live" question — it lives in its own workspace, dispatches everywhere.

5. **Mobile-first or desktop-first?** → Mobile-first. Validates information hierarchy with tighter constraints. Desktop follows from mobile decisions.

---

## Orchestrator Workspace Pattern

The orchestrator agent needs a home. It can't run inside a project workspace (e.g., `buildd-web`) because it manages missions *across* workspaces.

**Solution: `buildd-meta` workspace.**

```
buildd-meta (orchestrator workspace)
  ├── No git repo attached
  ├── Orchestrator skill installed
  ├── Schedule: run every 1h
  └── Creates tasks INTO other workspaces:
        ├── buildd-web: "Fix auth module test failure"
        ├── buildd-docs: "Update API reference"
        └── memory-service: "Review stale memories"
```

The orchestrator task runs in `buildd-meta`, reads all missions via `GET /api/missions` (cross-workspace), and creates follow-up tasks in the correct workspace via `POST /api/tasks` with the target `workspaceId`.

**This already works.** The `create_task` MCP tool accepts `workspaceId`. The orchestrator just needs to know which workspace maps to which mission — and that's already in the objective record (`objective.workspaceId`).

**Runner implication:** The runner that claims orchestrator tasks doesn't need a git repo checkout. It just needs API access. Could even be a lightweight runner instance with no code tooling — purely an API coordinator.

```
Runner A (code machine):  claims Build/Watch tasks → needs git, Claude, tools
Runner B (orchestrator):  claims meta tasks → needs only API access, lightweight
```

Or same runner handles both — it already skips worktree setup for tasks without a repo.
