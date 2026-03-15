# Buildd Missions Architecture

**Research Date:** 2026-03-14  
**Commit Reference:** `1228f5e` (main branch)  
**Conducted on:** `dev` branch  

## Executive Summary

Buildd's current architecture comprises three independent but interconnected systems:
1. **Heartbeats** — Runner instance liveness tracking (every 5 minutes)
2. **Objectives** — First-class goals with progress tracking and optional recurring execution
3. **Schedules** — Cron-based task creation with trigger conditions and active-hours gating
4. **Skills** — Workspace-scoped templates for task execution
5. **Task Lifecycle** — Task creation, claiming, worker execution, and completion with result snapshots

The proposed "Missions" UI concept maps cleanly onto objectives + schedules, adding opinionated UX for three mission types: **Build**, **Watch**, and **Brief**.

---

## Part A: Current State Map

### 1. Heartbeat System

**Location:** `apps/runner/src/workers.ts:672-689` and `apps/web/src/app/api/workers/heartbeat/route.ts`

#### Frequency
- **Runner sends:** Every 5 minutes (`apps/runner/src/workers.ts:236`)
  ```typescript
  this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), 5 * 60_000);
  ```
- **Server processes:** External cron job via `cron-job.org`, runs every 1 minute (`CLAUDE.md` note)

#### What Gets Sent
From `apps/web/src/app/api/workers/heartbeat/route.ts:30-35`:
```typescript
const {
  localUiUrl,           // URL of the runner UI (http://100.x.x.x:8766 or https://runner-xyz.coder.dev)
  activeWorkerCount = 0, // Number of workers in 'working' or 'waiting' status
  environment,          // Environment scan data (tools, env keys, MCP servers)
} = body;
```

#### Server-Side Processing
Lines 47-80: Upserts `workerHeartbeats` table:
- Unique index on `(accountId, localUiUrl)`
- Updates: `maxConcurrentWorkers`, `activeWorkerCount`, `environment`, `lastHeartbeatAt`
- **Workspaces no longer stored** — resolved on-demand in `/api/workers/active` (lightweight optimization)
- Generates/reuses `viewerToken` for dashboard direct access

#### Worker Liveness Detection
**Timeout mechanism:** Adaptive, starts at 5 minutes (`adaptiveStaleTimeout: 300_000ms`), calibrated from recent cycle times.

- `checkStale()` runs every 30 seconds (`apps/runner/src/workers.ts:201`)
- Workers marked "stale" after timeout with no activity
- **Graduated recovery:** Sends soft probe first (idle recovery message) before marking terminal stale
- `lastHeartbeatAt` column used to detect runner instance restarts

**Schema location:** `packages/core/db/schema.ts:452-469`
```typescript
export const workerHeartbeats = pgTable('worker_heartbeats', {
  id: uuid('id').primaryKey().defaultRandom(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }).notNull(),
  localUiUrl: text('local_ui_url').notNull(),
  viewerToken: text('viewer_token'),
  workspaceIds: jsonb('workspace_ids').default([]).notNull(), // Deprecated, resolved on-demand
  maxConcurrentWorkers: integer('max_concurrent_workers').default(3).notNull(),
  activeWorkerCount: integer('active_worker_count').default(0).notNull(),
  environment: jsonb('environment').$type<WorkerEnvironment>(),
  lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

#### What "Liveness" Means
- Runner instance is **reachable and online** — can accept task claims
- Does **NOT** mean individual workers are healthy (only that the runner process itself is alive)
- `activeWorkerCount` is for dashboard display ("2 agents active"), not for availability gating

---

### 2. Objectives (Current Model)

**Location:** `packages/core/db/schema.ts:300-327`, API: `apps/web/src/app/api/objectives/`

#### Schema
```typescript
export const objectives = pgTable('objectives', {
  id: uuid('id').primaryKey().defaultRandom(),
  teamId: uuid('team_id').references(() => teams.id).notNull(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').default('active').notNull(),  // 'active' | 'paused' | 'completed' | 'archived'
  priority: integer('priority').default(0).notNull(),
  cronExpression: text('cron_expression'),              // Optional, for recurring schedules
  defaultOutputRequirement: text('default_output_requirement'),
  scheduleId: uuid('schedule_id'),                      // FK to task_schedules, auto-created if cronExpression set
  parentObjectiveId: uuid('parent_objective_id'),       // Sub-objectives
  createdByUserId: uuid('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  
  // Heartbeat mode — periodic health checks
  isHeartbeat: boolean('is_heartbeat').default(false).notNull(),
  heartbeatChecklist: text('heartbeat_checklist'),      // e.g., "Check API, check DB, check cache"
  activeHoursStart: integer('active_hours_start'),      // 0-23, null = always active
  activeHoursEnd: integer('active_hours_end'),
  activeHoursTimezone: text('active_hours_timezone'),   // e.g., 'America/New_York'
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

#### Task Relationship
- **Foreign key:** `tasks.objectiveId` → `objectives.id` (lines 358)
- **Computation:** Progress = (completed tasks / total tasks) * 100
- **API calculation:** `apps/web/src/app/api/objectives/route.ts:60-70`
  ```typescript
  const totalTasks = obj.tasks?.length || 0;
  const completedTasks = obj.tasks?.filter(t => t.status === 'completed').length || 0;
  const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  ```

#### CRUD Operations
- **POST /api/objectives** (line 79-195): Create, auto-creates schedule if `cronExpression` provided
- **GET /api/objectives** (line 10-77): List, filters by status/workspace, computes progress
- **PATCH /api/objectives/[id]** (line 95-283): Update, syncs schedule if cron changes
- **DELETE /api/objectives/[id]**: Delete (handler location inferred from route structure)

#### Heartbeat Mode (Special Feature)
- `isHeartbeat: true` marks objective as a recurring health check
- `activeHoursStart/End` gates execution to specific time windows (e.g., "run daily 9am-5pm")
- `heartbeatChecklist` is free-form text guidance
- **Schema location for active hours check:** `apps/web/src/app/api/cron/schedules/route.ts:291-298`
  ```typescript
  if (linkedObjective?.isHeartbeat && linkedObjective.activeHoursStart != null) {
    const tz = linkedObjective.activeHoursTimezone || schedule.timezone || 'UTC';
    const currentHourStr = new Date().toLocaleString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    // Skip task creation if outside active hours
  }
  ```

#### MCP Exposure
**`packages/core/mcp-tools.ts:858-956`** — `manage_objectives` action:
- `list`: Query objectives with status/workspace filters
- `create`: Create objective, optionally with cronExpression and heartbeat settings
- `get`: Fetch details including linked tasks and progress
- `update`: Modify title, status, cron, heartbeat settings
- `delete`: Remove objective
- `link_task`: Connect task to objective (PATCH `task.objectiveId`)
- `unlink_task`: Remove task from objective

---

### 3. Schedules (Cron-Based Task Creation)

**Location:** `packages/core/db/schema.ts:483-510`, execution: `apps/web/src/app/api/cron/schedules/route.ts`

#### Schema
```typescript
export const taskSchedules = pgTable('task_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id).notNull(),
  name: text('name').notNull(),
  cronExpression: text('cron_expression').notNull(),    // Standard cron format
  timezone: text('timezone').default('UTC').notNull(),
  taskTemplate: jsonb('task_template').notNull().$type<TaskScheduleTemplate>(),
  enabled: boolean('enabled').default(true).notNull(),
  oneShot: boolean('one_shot').default(false).notNull(),  // Fire once then disable
  nextRunAt: timestamp('next_run_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  lastTaskId: uuid('last_task_id'),
  totalRuns: integer('total_runs').default(0).notNull(),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  lastError: text('last_error'),
  maxConcurrentFromSchedule: integer('max_concurrent_from_schedule').default(1).notNull(),
  pauseAfterFailures: integer('pause_after_failures').default(5).notNull(),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  lastTriggerValue: text('last_trigger_value'),         // For change-detection triggers
  totalChecks: integer('total_checks').default(0).notNull(),
  createdByUserId: uuid('created_by_user_id').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

#### Task Template (What Gets Created)
```typescript
export interface TaskScheduleTemplate {
  title: string;
  description?: string;
  mode?: 'execution' | 'planning';
  priority?: number;
  runnerPreference?: 'any' | 'user' | 'service' | 'action';
  requiredCapabilities?: string[];
  context?: Record<string, unknown>;
  trigger?: ScheduleTrigger;                            // Optional conditional trigger
}

export interface ScheduleTrigger {
  type: 'rss' | 'http-json';
  url: string;
  path?: string;                                        // Dot notation path to extract value
  headers?: Record<string, string>;
}
```

#### Execution Flow
**Triggered by:** External cron-job.org calling `GET /api/cron/schedules?Authorization: Bearer $CRON_SECRET` every 1 minute

**Lines 100-400 of `/api/cron/schedules/route.ts`:**
1. **Find due schedules:** `nextRunAt <= now` and `enabled=true`
2. **Check trigger condition (if present):**
   - Fetch from RSS or HTTP endpoint
   - Extract value using dot-notation path
   - Compare to `lastTriggerValue` for change detection
   - Skip task creation if no change (save capacity)
3. **Concurrency check:** Count active tasks from this schedule, respect `maxConcurrentFromSchedule`
4. **Atomic claim:** UPDATE with WHERE on `nextRunAt` to prevent double-creation (lines 205-228)
5. **Create task:** Insert into `tasks` table with:
   - `context.scheduleId`, `context.scheduleName`, trigger metadata injected
   - `externalId: schedule-{id}-{triggerValue}` for dedup on re-runs
   - Inherits `creationSource: 'schedule'`
6. **Update schedule:** Set `lastRunAt`, `nextRunAt`, increment `totalRuns`, reset `consecutiveFailures`

#### Linking to Objectives
- **Bidirectional:** `objectives.scheduleId` FK to `taskSchedules.id`
- When objective created with `cronExpression`, schedule auto-created (`apps/web/src/app/api/objectives/route.ts:154-188`)
- Schedule embedded in objective's template context

---

### 4. Skills (Workspace-Level Templates)

**Location:** `packages/core/db/schema.ts:570-587`, API: `/api/workspaces/[id]/skills`

#### Schema
```typescript
export const workspaceSkills = pgTable('workspace_skills', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id).notNull(),
  slug: text('slug').notNull(),                         // e.g., 'review-pr', 'audit-security'
  name: text('name').notNull(),
  description: text('description'),
  content: text('content').notNull(),                   // Full SKILL.md file contents
  contentHash: text('content_hash').notNull(),          // SHA-256 for verification
  source: text('source'),                               // e.g., 'local_scan', 'github:org/repo'
  enabled: boolean('enabled').default(true).notNull(),
  origin: text('origin').default('manual').notNull(),  // 'scan' | 'manual'
  metadata: jsonb('metadata').default({}),              // referenceFiles, version, author
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

#### Relationship to Tasks
- **Not a direct FK:** Tasks reference skills by `slug` string in `task.context.skillSlugs` (array)
- **Passed to SDK:** SDK receives skill content as context, agent uses it as a template/guide
- **Resolution:** Done at task creation time (`apps/web/src/app/api/tasks/route.ts:236-253`), validates skill exists
- **Storage:** Workspace-scoped, unique by `(workspaceId, slug)`

#### Execution Model
- Skills are **templates/guidance**, not executable code (except as MCP-registered skills)
- **Via MCP:** Agents can register and execute skills using `@buildd-ai/memory` or local skill files
- Skills in `.claude/skills/*/SKILL.md` are automatically registered in workspaces

#### Current Skills
Located in `.claude/skills/`:
- `ui_designer/` — Brand guidelines, design tokens, component patterns
- `ui-audit/` — UX evaluation framework
- `competitive-landscape/` — Market analysis templates
- `sdk-changelog-monitor/` — Track SDK releases
- `buildd-workflow/` — Task lifecycle guide (claim → work → ship)
- `ralph-loop/` — Verification loop guidance

---

### 5. Task Lifecycle

**Schema:** `packages/core/db/schema.ts:329-375`, API: `apps/web/src/app/api/tasks/`, workers: `apps/web/src/app/api/workers/`

#### Task Fields (Key for Missions)
```typescript
export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').references(() => workspaces.id).notNull(),
  title: text('title').notNull(),
  description: text('description'),
  context: jsonb('context').default({}).$type<Record<string, unknown>>(),  // Flexible metadata
  status: text('status').default('pending').notNull(),  // pending|assigned|in_progress|completed|failed
  priority: integer('priority').default(0).notNull(),
  mode: text('mode').default('execution').notNull(),    // 'execution' | 'planning'
  runnerPreference: text('runner_preference').default('any').notNull(),
  requiredCapabilities: jsonb('required_capabilities').default([]),
  claimedBy: uuid('claimed_by').references(() => accounts.id),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdByWorkerId: uuid('created_by_worker_id'),       // For task chaining
  creationSource: text('creation_source').default('api'), // 'dashboard'|'api'|'mcp'|'schedule'
  parentTaskId: uuid('parent_task_id'),                 // Self-reference for task trees
  category: text('category'),                           // 'bug'|'feature'|'refactor'|'chore'|'docs'
  project: text('project'),                             // Monorepo project scoping
  outputRequirement: text('output_requirement').default('auto'), // 'pr_required'|'artifact_required'|'none'
  outputSchema: jsonb('output_schema'),                 // JSON Schema for structured output
  objectiveId: uuid('objective_id').references(() => objectives.id), // Mission linking
  dependsOn: jsonb('depends_on').default([]).$type<string[]>(), // DAG dependencies
  result: jsonb('result').$type<TaskResult | null>(),  // Populated on completion
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
```

#### Task Result (What Gets Captured)
```typescript
export interface TaskResult {
  summary?: string;
  branch?: string;
  commits?: number;
  sha?: string;
  files?: number;
  added?: number;
  removed?: number;
  prUrl?: string;
  prNumber?: number;
  structuredOutput?: Record<string, unknown>;           // From outputSchema validation
}
```

#### Creation Flow
**POST /api/tasks** (`apps/web/src/app/api/tasks/route.ts:123-290`):
1. **Auth:** API key (admin level) or session
2. **Workspace resolution:** UUID, repo name ("owner/repo"), or workspace name
3. **Skill validation:** If `skillSlugs` provided, validate each exists and is enabled
4. **Creator tracking:** Resolve API account, user, or worker ID
5. **Objective linking:** Optional `objectiveId` (inherit from parent if subtask)
6. **Dependency DAG:** Optional `dependsOn` array of task IDs
7. **Insert task:** Set all fields, `status='pending'`
8. **Task dispatch:** If `runnerPreference` set, direct assignment via `dispatchNewTask()`

#### Claiming Flow
**POST /api/workers/claim** (`apps/web/src/app/api/workers/claim/route.ts`):
1. Worker calls with account + workspace filters
2. DB query: Find highest-priority unclaimed task
3. Check dependencies resolved via `checkDependsOnResolved()`
4. Update: `tasks.status='assigned'`, `tasks.claimedBy=accountId`, `tasks.claimedAt=now`
5. Create worker record: `INSERT INTO workers` with branch name, status='idle'
6. Return task details to runner

#### Execution Flow
Worker runs SDK agent loop on the task, sends updates via **PATCH /api/workers/[id]** with:
- `status: 'running' | 'waiting_input' | 'completed' | 'failed'`
- `currentAction`: Current step description
- `milestones`: Array of {type, label, timestamp} events (git commits, PR opens, etc.)
- `costUsd`, `inputTokens`, `outputTokens`, `turns`: Usage metrics
- `lastCommitSha`, `commitCount`, `filesChanged`, `linesAdded`, `linesRemoved`: Git stats

#### Completion Flow
**PATCH /api/workers/[id] with status='completed'** (`apps/web/src/app/api/workers/[id]/route.ts:48-497`):
1. **Validate deliverables:** Check PR or artifact existence if `outputRequirement` enforced
2. **Update task:** Set `status='completed'`, snapshot `result`
3. **Resolve dependencies:** Fire `TASK_UNBLOCKED` events for dependent tasks
4. **Auto-artifacts:** If `outputSchema` provided, upsert artifact from structured output
5. **Notifications:** Pushover, Slack, Discord if configured
6. **Webhook callback:** POST to `task.context.callback.url` if present

#### Worker Status Transitions
```
idle → running → completed  ✓
                → failed    ✗
                → waiting_input  (plan approval, questions)
```

---

## Part B: Missions → Current System Mapping

### Mission Type 1: Build Mission
**Intent:** Collaborate with agent to implement feature, fix bug, or refactor code.

**Maps to:**
- **Primary:** One `objective` with status='active', auto-progress tracking
- **Tasks:** Multiple linked tasks (breakdown of work)
- **Execution:** One worker per task, sequentially or in parallel (based on dependencies)
- **Result:** PR creation + merge, git history captures progress

**UI Proposal:**
```
Build: "Add dark mode support to dashboard"
├─ Breakdown: "Identify theme files, design system updates, component changes"
├─ Progress: 33% (1 of 3 subtasks completed)
├─ Linked Workers: 2 active, 1 idle
├─ Last activity: 2m ago
├─ Estimated time: 2–4 hours based on task history
└─ Cost: $12.45 + estimated $15–20 remaining
```

**What happens:**
1. User creates mission with one-sentence intent
2. Agent breaks down into subtasks, creates task tree with `parentTaskId` chaining
3. First task claims → agent works → creates PR
4. Subsequent tasks pick up from PR branch or create new branches
5. Final task merges PR and marks objective 'completed'

**Key fields:**
- `objective.objectiveId` = mission ID
- `task.parentTaskId` = task hierarchy
- `task.dependsOn` = execution ordering
- `worker.taskId` = current work unit

---

### Mission Type 2: Watch Mission
**Intent:** Recurring monitoring/health checks (e.g., "Check API uptime daily", "Review security advisories weekly").

**Maps to:**
- **Primary:** One `objective` with `isHeartbeat=true`, `cronExpression` set
- **Schedule:** Auto-created `taskSchedule` linked via `objective.scheduleId`
- **Active hours:** Optional time window (e.g., 9am-5pm in user's timezone)
- **Progress:** Last execution status + timestamp (not traditional %-based progress)

**UI Proposal:**
```
Watch: "Check production API health"
├─ Recurrence: Daily at 2pm UTC (next: in 3h 22m)
├─ Active hours: 9:00–17:00 America/New_York
├─ Status: Healthy ✓ (last checked 2h ago)
├─ Last result: All endpoints responding <200ms
├─ Linked skill: "production-health-check"
└─ Pause/Edit/View History
```

**What happens:**
1. Cron scheduler wakes up at `nextRunAt`
2. Check active hours window (gated via `apps/web/src/app/api/cron/schedules/route.ts:291-298`)
3. Create task from `taskTemplate`
4. Agent executes skill, captures health status in `result.structuredOutput.status`
5. API extracts `lastHeartbeatStatus` from most recent completed task
6. Dashboard shows status badge + timestamp

**Key fields:**
- `objective.isHeartbeat=true`
- `objective.activeHoursStart/End/Timezone`
- `taskSchedules.cronExpression` (e.g., "0 14 * * *" for 2pm daily)
- `taskSchedules.lastRunAt`, `nextRunAt`
- `task.result.structuredOutput.status`

---

### Mission Type 3: Brief Mission
**Intent:** One-time research or analysis (e.g., "Analyze competitor's new feature", "Research best practices for X").

**Maps to:**
- **Primary:** One `objective` with no cron, single or multiple tasks
- **Output:** Artifact (research document, analysis report, findings)
- **Status:** After artifact created, objective can be marked 'completed'

**UI Proposal:**
```
Brief: "Competitive analysis: How Vercel handles AI integrations"
├─ Status: In Progress (assigned)
├─ Artifact: (none yet)
├─ Started: 45m ago
├─ Estimated time: 1–2 hours
└─ Cost: $2.15 so far (estimated total: $5–8)

[View Research / View Progress / Edit / Archive]
```

**What happens:**
1. User creates mission with research prompt
2. Agent creates research task with `outputRequirement='artifact_required'`
3. Agent works → creates artifact(s) of type 'report', 'data', 'analysis', etc.
4. Artifact linked to worker (`artifacts.workerId`)
5. Dashboard fetches artifact, displays in mission detail
6. User marks objective 'completed' when satisfied

**Key fields:**
- `objective.objectiveId` = mission ID (no schedule)
- `task.outputRequirement='artifact_required'`
- `task.mode='planning'` (research/analysis)
- `artifacts.type='report'|'analysis'|'summary'`
- `artifacts.workspaceId` for sharing

---

## Part C: Mission Creation UX Proposal

### Minimum Info Required
```
[What do you want to work on?]
[ Build | Watch | Brief ] [selected] ↓
[One-sentence summary]
[Select workspace]
[Frequency for Watch missions (optional)]
```

### Opinionated Auto-Configuration by Type

#### Build Mission
1. Parse title for intent (via agent `plan` mode)
2. Suggest task breakdown (3–5 subtasks)
3. Create objective + auto-link to workspace
4. Set `outputRequirement='pr_required'` for execution tasks
5. Create first subtask, wait for user to claim/trigger

#### Watch Mission
1. Parse title to extract monitoring target
2. Suggest frequency based on intent ("Check X daily" → "0 * * * *", "Check X weekly" → "0 0 * * 1")
3. Allow time window customization (active hours)
4. Suggest relevant skill from workspace skills or memory
5. Create objective with `isHeartbeat=true` + auto-create schedule + first task (for approval)

#### Brief Mission
1. Parse title to identify research area
2. Set `mode='planning'` for initial breakdown task
3. Suggest artifact type (e.g., 'report' if "analyze", 'summary' if "research")
4. Link to relevant skills (competitive-landscape, sdk-changelog-monitor, etc.)
5. Create task with `outputSchema` for structured findings (optional)

### Frequency Setup (Watch Missions)
```
Frequency:
  Hourly (0 * * * *)
  Daily (0 9 * * *) ← suggests 9am in user's timezone
  Weekly (0 9 * * 1) ← Monday 9am
  Every Monday & Thursday (0 9 * * 1,4)
  Custom cron: [________]

Active hours (optional):
  Enabled / Disabled
  Start: [9:00 AM]
  End: [5:00 PM]
  Timezone: [America/New_York] ↓
```

---

## Part D: Heartbeat → Mission Status

### Data Flow

#### 1. Worker Heartbeat → Dashboard Status

When `sendHeartbeat()` fires (`apps/runner/src/workers.ts:672-689`):
```typescript
const activeCount = Array.from(this.workers.values()).filter(
  w => w.status === 'working' || w.status === 'waiting'
).length;
```

Server receives in `POST /api/workers/heartbeat`:
- `activeWorkerCount` → stored in `workerHeartbeats.activeWorkerCount`
- `lastHeartbeatAt` → timestamp of last ping

Dashboard can display:
```
Mission "Build X" · 2 agents active (synced 1m ago)
```

#### 2. Task Completion → Progress Update

When worker completes task via `PATCH /api/workers/[id]` with `status='completed'`:
1. API updates `tasks.status='completed'`, snapshots `task.result`
2. Triggers `resolveCompletedTask()` → fires Pusher `TASK_COMPLETED` event
3. API fetches objective, recomputes progress:
   ```typescript
   const totalTasks = obj.tasks?.length;
   const completed = obj.tasks?.filter(t => t.status === 'completed').length;
   const progress = Math.round((completed / totalTasks) * 100);
   ```
4. Emits Pusher `OBJECTIVE_UPDATED` with new `progress` value

#### 3. Heartbeat Status (Watch Missions)

For watch missions (`isHeartbeat=true`):
1. Schedule fires → creates task
2. Agent executes health check → records `result.structuredOutput.status`
3. API extracts in `GET /api/objectives/[id]` (`apps/web/src/app/api/objectives/[id]/route.ts:63-74`):
   ```typescript
   const lastCompletedTask = objective.tasks?.find(
     (t: any) => t.status === 'completed' && t.result?.structuredOutput?.status
   );
   if (lastCompletedTask) {
     lastHeartbeatStatus = lastCompletedTask.result?.structuredOutput?.status;
     lastHeartbeatAt = lastCompletedTask.updatedAt;
   }
   ```
4. Returns to dashboard:
   ```json
   {
     "lastHeartbeatStatus": "healthy",
     "lastHeartbeatAt": "2026-03-14T14:30:22Z"
   }
   ```

#### 4. Activity Feed Items

Milestones captured in `workers.milestones` (JSONB array):
```typescript
{
  label: string;        // e.g., "Opened PR #123", "Completed 3 files"
  timestamp: number;    // ms since epoch
  type?: string;        // 'git', 'pr', 'artifact', 'checkpoint'
  metadata?: object;    // { prNumber: 123, branch: "feat/x" }
}
```

Dashboard streams these via Pusher `WORKER_UPDATE` events, displays as activity timeline.

---

## Part E: Cost Visibility (Light Touch)

### Where Cost Shows Up (Optional, Not MVP)

**Proposed for Mission Detail Page (collapsed by default):**
```
Usage & Cost
├─ Agents active: 2 (Opus 4.6, Haiku 4.5)
├─ Runtime: 2h 15m
├─ Model usage:
│  ├─ Claude Opus: 145k input + 52k output tokens = $4.82
│  └─ Claude Haiku: 89k input + 12k output tokens = $0.34
├─ Total: $5.16
└─ Estimated remaining: $12–18 (based on task history)
```

### What Data Exists Today

- **Per-worker cost:** `workers.costUsd` (cumulative from worker completions)
- **Per-worker tokens:** `workers.inputTokens`, `workers.outputTokens`
- **Per-task total:** Sum of all worker costs via SQL: `SELECT SUM(costUsd) FROM workers WHERE taskId = ?`
- **Per-objective budget tracking:** None currently, could add `objectives.estimatedBudgetUsd`

### Claude Max Users (Seat-Based)

For seat-based accounts (`accounts.authType='oauth'`):
- No per-token cost tracking needed
- Show "usage metrics" instead:
  ```
  Usage (this cycle)
  ├─ Tasks run: 23
  ├─ Total runtime: 18h 42m
  └─ Seat utilization: 2/5 seats active
  ```

### Implementation Notes

- Cost data already captured in `workers.resultMeta.modelUsage` (per model)
- Summary query: `SELECT SUM(costUsd), SUM(inputTokens), SUM(outputTokens) FROM workers WHERE objectiveId = ?`
- Display only if `workspace.gitConfig.maxCostPerDay` is set (cost-aware workspace)

---

## Part F: The Orchestrator Pattern

### Challenge
Missions need to "stay fresh" — progress updates, new tasks created when needed, status kept current. How does the system keep tabs on all missions automatically?

### Solution: Mission Orchestrator Skill

**Proposed:** A recurring agent task that runs on a schedule and reviews all active missions.

#### Frequency
- Run every 1 hour (reconcile mode) or every 6 hours (full audit)
- Triggered via schedule on a hidden "maintenance" objective

#### What It Does
1. **List all active objectives** via MCP `manage_objectives action='list' status='active'`
2. **For each Build mission:**
   - Check linked tasks status
   - If stuck > 1h, create debug task: "Debug why task XYZ is stalled"
   - If no activity, suggest next steps
   - Mark 'completed' if all subtasks done + PR merged
3. **For each Watch mission:**
   - Check if `lastRunAt` is stale (overdue vs. nextRunAt)
   - If stale, manually fire task (don't wait for cron)
   - Extract status from result
4. **For each Brief mission:**
   - Check if artifact exists
   - If artifact found, offer user: "Research complete — [View] [Archive]"

#### Example Implementation
```typescript
async function orchestrateMissions() {
  const objectives = await api('/api/objectives', {
    headers: { Authorization: 'Bearer <admin-key>' }
  });
  
  for (const mission of objectives.objectives) {
    if (mission.status !== 'active') continue;
    
    // Build mission: check for stalled tasks
    if (!mission.isHeartbeat && mission.totalTasks > 0) {
      const stalledTasks = mission.tasks.filter(t => 
        t.status === 'assigned' && Date.now() - new Date(t.updatedAt) > 3600_000
      );
      if (stalledTasks.length > 0) {
        await api('/api/tasks', {
          method: 'POST',
          body: JSON.stringify({
            title: `Debug stalled task: ${stalledTasks[0].title}`,
            description: `Task assigned 1+ hours ago with no progress. Debug and resume.`,
            objectiveId: mission.id,
            parentTaskId: stalledTasks[0].id,
            mode: 'planning',
          })
        });
      }
    }
    
    // Watch mission: check if next run is overdue
    if (mission.isHeartbeat && mission.schedule) {
      const nextRunAt = new Date(mission.schedule.nextRunAt);
      if (nextRunAt < new Date()) {
        console.log(`[Orchestrator] Watch mission overdue: ${mission.title}, manually firing`);
        await api(`/api/objectives/${mission.id}/run`, { method: 'POST' });
      }
    }
    
    // Brief mission: check for artifacts
    if (!mission.isHeartbeat && mission.totalTasks === 1 && mission.tasks[0].status === 'completed') {
      const artifacts = await api(`/api/workspaces/${mission.workspace.id}/artifacts`, {
        params: { workspaceId: mission.workspace.id }
      });
      if (artifacts.artifacts.length > 0) {
        console.log(`[Orchestrator] Brief mission complete: ${mission.title}, artifact ready`);
        // Could emit notification or update mission status
      }
    }
  }
}
```

#### MCP Exposure
Register "mission orchestrator" as a recurring admin skill:
```typescript
case 'run_recipe': {
  if (params.recipeId === 'mission-orchestrator') {
    await orchestrateMissions();
    return text('Orchestrator cycle completed: all missions synchronized');
  }
}
```

#### Why This Works
- **No schema changes** — reuses existing objectives, tasks, schedules
- **Observable** — each orchestration run creates audit tasks (visible in mission history)
- **Failsafe** — if orchestrator crashes, just waits for next cycle (no state lost)
- **Extensible** — add more behaviors as needed (auto-escalation, notifications, etc.)

---

## Part G: Implementation Roadmap

### Phase 1: MVP (No Schema Changes)
- **UI:** New "Missions" tab on dashboard
- **Mapping:** Objectives → Missions (3 types via UI hints)
- **Creation:** Opinionated 3-form flow (Build/Watch/Brief)
- **Display:** Progress cards, status badges, activity timeline
- **Cost:** Show if available, hidden by default

**Effort:** 2–3 days (UI only)

### Phase 2: Orchestrator (Skill-Based)
- **Skill:** Mission orchestrator as recurring task
- **Trigger:** Schedule or admin dashboard button
- **Logic:** Stale task detection, Watch mission sync, Brief artifact check
- **Feedback:** Activity feed items for each orchestration action

**Effort:** 1–2 days (MCP integration + logic)

### Phase 3: Cost Visibility (Optional)
- **Schema:** Add `objectives.estimatedBudgetUsd`, `objectives.actualCostUsd`
- **Tracking:** Sum worker costs on task completion, update objective total
- **UI:** Budget bar, cost projection
- **Alerts:** "Objective at 80% budget, remaining $25"

**Effort:** 1 day

### Phase 4: Advanced (Future)
- **Auto-breakdown:** Agent-powered task breakdown for Build missions
- **Auto-retry:** Ralph loop for failed tasks (needs verification command)
- **Multi-user:** Invite collaborators to missions (role-based)
- **Templates:** Save mission patterns as reusable recipes

**Effort:** 2–4 days each

---

## Key Code References

| Concept | Location |
|---------|----------|
| Heartbeat send | `apps/runner/src/workers.ts:672-689` |
| Heartbeat receive | `apps/web/src/app/api/workers/heartbeat/route.ts:20-96` |
| Objective schema | `packages/core/db/schema.ts:300-327` |
| Objective CRUD | `apps/web/src/app/api/objectives/route.ts` + `[id]/route.ts` |
| Schedule execution | `apps/web/src/app/api/cron/schedules/route.ts:100-400` |
| Task creation | `apps/web/src/app/api/tasks/route.ts:123-290` |
| Worker completion | `apps/web/src/app/api/workers/[id]/route.ts:48-497` |
| MCP objectives tool | `packages/core/mcp-tools.ts:858-956` |
| Progress calculation | `apps/web/src/app/api/objectives/route.ts:60-70` |
| Heartbeat status extraction | `apps/web/src/app/api/objectives/[id]/route.ts:63-74` |
| Active hours gating | `apps/web/src/app/api/cron/schedules/route.ts:291-298` |
| Skills schema | `packages/core/db/schema.ts:570-587` |

---

## Conclusion

Buildd's heartbeat, objectives, and schedules systems are well-designed building blocks for the Missions concept. The proposed mapping is:
- **Build** = objective + multi-task tree with progress tracking
- **Watch** = objective + recurring schedule with active-hours gating
- **Brief** = objective + single/multi-task with artifact output

No schema changes required for MVP. The Orchestrator pattern provides the missing "supervision" layer to keep missions fresh and responsive. Cost visibility is optional and can be added incrementally.

This architecture enables users to think in terms of **goals** (missions), not **tasks**, while maintaining full traceability to the underlying task execution, worker activity, and results.

---
