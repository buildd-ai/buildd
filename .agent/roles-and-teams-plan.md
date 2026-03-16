# Agent Roles & Team Management — Implementation Plan

> Extend the skills system into agent roles with a "Team" dashboard.
> A skill IS a role. No separate concept — just richer fields on the same table.

## Context

The skills system is 95% built: schema, CRUD API, MCP `register_skill`, runner sync + subagent conversion, UI (list/form/settings). What's missing is the role config — model selection, tool restrictions, delegation rules — and a top-level Team page showing live agent status (Marcus AI "Office" pattern).

Mockups: `pencil-shadcn.pen` — "Buildd — Team" and "Buildd — Role Editor" frames.

**Design principle:** No backward compatibility shims. Do it right. Skills become roles — same table, richer schema, better UI.

---

## Conceptual Model: Roles, Missions, and Tasks

### Three independent concepts

```
Roles (persistent)     Missions (goals)       Tasks (work items)
┌──────────────┐      ┌──────────────┐       ┌──────────────┐
│ Builder      │      │ Ship v2      │──────▶│ Rename routes│
│ Researcher   │      │ (BUILD)      │       │ roleSlug:    │
│ Accountant   │      └──────────────┘       │  "builder"   │
│ Compliance   │      ┌──────────────┐       └──────┬───────┘
└──────┬───────┘      │ Monitor API  │              │
       │              │ (WATCH)      │──────▶ claimed by
       │              └──────────────┘       matching role
       │              ┌──────────────┐
       └──── picks ──▶│ Ad-hoc task  │
            up work   │ (no mission) │
                      └──────────────┘
```

### Relationships

- **Roles = employees.** Persistent agent personas with skills, tools, and personality. They exist whether or not there's work for them.
- **Missions = projects.** Goals that generate work. BUILD missions end. WATCH missions are ongoing responsibilities. BRIEF missions produce periodic output. "Mission" covers the full spectrum from finite to ambient.
- **Tasks = work items.** The link between roles and missions. A mission creates tasks. Tasks get routed to roles via `roleSlug`.

### Many-to-many through tasks

- A role can work on tasks from **multiple missions** (Builder works on Ship v2 AND a hotfix mission)
- A mission can have tasks handled by **multiple roles** (Ship v2 needs Builder AND QA)
- A role can pick up **ad-hoc tasks** with no mission at all
- Roles **don't belong to** missions — missions just express a **preference** for which role should handle their tasks (`defaultRoleSlug`)

### What "ongoing" means

WATCH missions already solve the "beyond a mission" concern — they're ongoing, no end date, continuously generating tasks. A Compliance role running a WATCH mission "Review policy docs weekly" is effectively a persistent responsibility. The mission framework already supports this via cron + `isHeartbeat`.

### Team page shows current activity, not assignment

The Team page doesn't show "Builder is assigned to Ship v2." It shows "Builder is currently working on 'Rename API routes' (from Ship v2, 12m ago)." The role's identity is its skills and config, not which mission it's on.

---

## Phase 1: Schema & Types

**Goal:** Add role fields to `workspaceSkills`. Make them required where they should be.

### 1.1 Extend `workspaceSkills` table

**File:** `packages/core/db/schema.ts`

Add columns:

```typescript
model: text('model').$type<'sonnet' | 'opus' | 'haiku' | 'inherit'>().notNull().default('inherit'),
allowedTools: jsonb('allowed_tools').notNull().default([]).$type<string[]>(), // empty = all tools
canDelegateTo: jsonb('can_delegate_to').notNull().default([]).$type<string[]>(), // slugs of other skills
background: boolean('background').notNull().default(false),
maxTurns: integer('max_turns'), // null = unlimited
color: text('color').notNull().default('#8A8478'), // avatar color hex, default gray
mcpServers: jsonb('mcp_servers').notNull().default([]).$type<string[]>(), // MCP server names this role requires
requiredEnvVars: jsonb('required_env_vars').notNull().default({}).$type<Record<string, string>>(), // env var name → secret label mapping
```

Add `roleSlug` to `tasks` table in the same migration (Phase 6 is not "future" — do it now):

```typescript
roleSlug: text('role_slug'), // if set, only runners with this skill can claim
```

### 1.2 Data migration

In the generated migration SQL, add a statement to set `color` for any existing skills to a default palette based on row order, so they look good on the Team page immediately.

### 1.3 Generate migration

```bash
cd packages/core && bun db:generate
```

### 1.4 Update shared types

**File:** `packages/shared/src/types.ts`

```typescript
export type SkillModel = 'sonnet' | 'opus' | 'haiku' | 'inherit';

export interface WorkspaceSkill {
  id: string;
  workspaceId: string;
  slug: string;
  name: string;
  description: string | null;
  content: string;
  contentHash: string;
  source: string | null;
  enabled: boolean;
  origin: WorkspaceSkillOrigin;
  metadata: SkillMetadata;
  // Role config
  model: SkillModel;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillBundle {
  slug: string;
  name: string;
  description?: string;
  content: string;
  contentHash?: string;
  referenceFiles?: Record<string, string>;
  files?: SkillBundleFile[];
  // Role config
  model: SkillModel;
  allowedTools: string[];
  canDelegateTo: string[];
  background: boolean;
  maxTurns: number | null;
}

export interface CreateWorkspaceSkillInput {
  slug?: string;
  name: string;
  description?: string;
  content: string;
  source?: string;
  metadata?: SkillMetadata;
  enabled?: boolean;
  // Role config
  model?: SkillModel;
  allowedTools?: string[];
  canDelegateTo?: string[];
  background?: boolean;
  maxTurns?: number;
  color?: string;
}
```

---

## Phase 2: API

**Goal:** All routes accept and return role fields. Add task routing by `roleSlug`.

### 2.1 Skills CRUD

**File:** `apps/web/src/app/api/workspaces/[id]/skills/route.ts`

- POST: accept all new fields in body, include in `db.insert()`
- GET: already returns full rows — just verify new columns come through

**File:** `apps/web/src/app/api/workspaces/[id]/skills/[skillId]/route.ts`

- PATCH: accept `model`, `allowedTools`, `canDelegateTo`, `background`, `maxTurns`, `color` in update payload

### 2.2 Claim route — bundle role config + filter by roleSlug

**File:** `apps/web/src/app/api/workers/claim/route.ts`

Two changes:

**a) Task filtering by roleSlug:**
When a task has `roleSlug` set, only claim it if the worker's claim request includes that slug in its `availableSkills` array. Add to the claim request body:

```typescript
// New field in claim request:
availableSkills?: string[]; // slugs this runner can execute
```

SQL filter addition (alongside existing `requiredCapabilities` and `dependsOn` checks):
```sql
AND (tasks.role_slug IS NULL OR tasks.role_slug = ANY(:availableSkills))
```

**b) Bundle role fields:**
```typescript
const skillBundles: SkillBundle[] = skills.map(s => ({
  slug: s.slug,
  name: s.name,
  description: s.description ?? undefined,
  content: s.content,
  contentHash: s.contentHash,
  referenceFiles: (s.metadata as SkillMetadata)?.referenceFiles,
  model: s.model,
  allowedTools: s.allowedTools,
  canDelegateTo: s.canDelegateTo,
  background: s.background,
  maxTurns: s.maxTurns,
}));
```

### 2.3 MCP `register_skill`

**File:** `packages/core/mcp-tools.ts`

Add all new fields to `register_skill` action params. Pass through to API.

### 2.4 Task creation — accept roleSlug

**File:** `apps/web/src/app/api/tasks/route.ts`

Accept `roleSlug` in task creation body. Store on task row.

**File:** `packages/core/mcp-tools.ts` — `create_task` action

Add `roleSlug` param, pass through.

---

## Phase 3: Runner

**Goal:** Runner uses role config for AgentDefinition. Announces available skills when claiming.

### 3.1 Announce skills on claim

**File:** `apps/runner/src/workers.ts`

When calling `POST /api/workers/claim`, include the list of skill slugs configured for this workspace:

```typescript
const claimBody = {
  // ...existing fields...
  availableSkills: configuredSkillSlugs, // from workspace git config or runner config
};
```

### 3.2 Use role config in AgentDefinition

**File:** `apps/runner/src/workers.ts` (~lines 2170-2184)

```typescript
agents[bundle.slug] = {
  description: bundle.description || bundle.name,
  prompt: bundle.content,
  tools: bundle.allowedTools.length > 0
    ? bundle.allowedTools
    : ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
  model: bundle.model,
  background: bundle.background || useBackgroundAgents,
  ...(useWorktreeIsolation ? { isolation: 'worktree' } : {}),
  ...(bundle.maxTurns ? { maxTurns: bundle.maxTurns } : {}),
};

// Delegation: add Task(<slug>) tool for each delegatee
if (bundle.canDelegateTo.length > 0) {
  agents[bundle.slug].tools = [
    ...agents[bundle.slug].tools,
    ...bundle.canDelegateTo.map(slug => `Task(${slug})`),
  ];
}
```

---

## Phase 4: Team Page

**Goal:** New top-level `/app/team` page — the "Office" view.

### 4.1 Create page

**File:** `apps/web/src/app/app/(protected)/team/page.tsx` (NEW)

**Data loading:**
1. Query all `workspaceSkills` across user's workspaces (enabled only)
2. Query active workers (status: running, starting, waiting_input)
3. Join workers → tasks → task.context.skillSlugs to determine which role each worker is executing
4. Also check task.roleSlug for direct role assignment

**Layout (per mockup):**
- Header: "The Team" + live count badge + "+ New Role" button
- Active roles section: card grid (3 columns max)
  - Each card: avatar circle (using `skill.color` + first initial), name, description, status badge, current task box with title + workspace + time + PR link
  - Green border = running, amber border = needs input
- Idle section: compact row of role chips with gray styling
- Click card → navigate to `/app/workspaces/[wsId]/skills?edit=[skillId]`

**Real-time:**
- Subscribe to Pusher channels for workspace workers
- Update card status live when workers change state
- Animate transitions (e.g., idle → running)

### 4.2 Navigation

**File:** `apps/web/src/app/app/(protected)/missions/MissionsSidebar.tsx`

Add between Missions and bottom:
```tsx
{ label: 'Team', href: '/app/team', icon: UsersIcon }
```

**File:** `apps/web/src/app/app/(protected)/missions/MissionsBottomNav.tsx`

Add "Team" tab.

### 4.3 Home page integration

**File:** `apps/web/src/app/app/(protected)/home/page.tsx`

Replace the "active agents" section with a mini Team view — show active role avatars with names and current task, linking to `/app/team`.

---

## Phase 5: Role Editor

**Goal:** Upgrade SkillForm into a proper Role Editor with all config fields.

### 5.1 Two-column form layout

**File:** `apps/web/src/app/app/(protected)/workspaces/[id]/skills/SkillForm.tsx`

Redesign as two-column layout (per mockup):

**Left column (identity):**
- Role Name (text input)
- Goal / Description (text input with helper text)
- Instructions (textarea — the SKILL.md content, this is the "backstory")

**Right column (config):**
- Model selector (dropdown: Claude Opus 4, Claude Sonnet 4, Claude Haiku 4.5, Inherit)
- Allowed Tools (chip multi-select, dark=active, light=available):
  - Default set: Read, Write, Edit, Bash, Grep, Glob
  - Extended: WebSearch, WebFetch, Agent, NotebookEdit
  - Empty selection = all tools (no restriction)
- Can Delegate To (chip selector of other workspace skills, green=selected)
- Skills (chip selector to preload other skill contexts)
- Settings:
  - Checkbox: "Run in isolated worktree"
  - Checkbox: "Allow background execution"
  - Number input: "Max turns" (optional)
- Color picker (preset palette of 8-10 colors for avatar)

### 5.2 Skill detail page

**File:** `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/page.tsx` (NEW)

Dedicated edit page with:
- Breadcrumb: Team / {workspace} / {role name}
- Avatar + name header with stats (created date, tasks completed count)
- Save Changes button
- Two-column form (reuse SkillForm component)
- Delete button (with confirmation)

### 5.3 Enhanced SkillList

**File:** `apps/web/src/app/app/(protected)/workspaces/[id]/skills/SkillList.tsx`

Each row shows:
- Color dot + name
- Model badge (small pill)
- Tool count
- Delegation targets as chips
- Enabled toggle
- Click → navigate to detail page

---

## Phase 6: Mission → Role Assignment

**Goal:** Missions can assign a default role to their generated tasks.

### 6.1 Add roleSlug to objectives

**File:** `packages/core/db/schema.ts`

```typescript
// On objectives table:
defaultRoleSlug: text('default_role_slug'),
```

### 6.2 Task schedule enrichment

**File:** `apps/web/src/lib/objective-context.ts`

When a mission generates a task via its schedule, copy `objective.defaultRoleSlug` → `task.roleSlug`.

### 6.3 Mission creation UI

**File:** `apps/web/src/app/app/(protected)/missions/new/NewMissionForm.tsx`

Add "Assign to role" dropdown showing workspace skills. Selected role becomes `defaultRoleSlug`.

---

## File Change Summary

| Phase | Files Modified | Files Created |
|-------|---------------|--------------|
| 1 | `schema.ts`, `types.ts` | Migration SQL |
| 2 | Skills routes (2), claim route, `mcp-tools.ts`, tasks route | — |
| 3 | `apps/runner/src/workers.ts` | — |
| 4 | `MissionsSidebar.tsx`, `MissionsBottomNav.tsx`, `home/page.tsx` | `team/page.tsx` |
| 5 | `SkillForm.tsx`, `SkillList.tsx` | `skills/[skillId]/page.tsx` |
| 6 | `schema.ts`, `objective-context.ts`, `NewMissionForm.tsx` | Migration SQL |

## PR Strategy

| PR | Phases | Description |
|----|--------|-------------|
| 1 | 1+2+3 | **Schema + API + Runner** — all backend work, one PR |
| 2 | 4 | **Team page** — new page + nav updates |
| 3 | 5 | **Role Editor** — enhanced skill form |
| 4 | 6 | **Mission → Role** — role assignment on missions |

## Testing

| Phase | Test file | What to test |
|-------|-----------|-------------|
| 1-2 | `apps/web/tests/integration/skills.test.ts` | Create skill with model/tools/delegation, update, verify claim bundles include new fields |
| 2 | `apps/web/tests/integration/skills.test.ts` | Task with roleSlug only claimable by matching runner |
| 3 | `packages/core/__tests__/worker-runner-skills.test.ts` | AgentDefinition uses model, tools, delegation, maxTurns from bundle |
| 4 | New E2E test | Team page renders active/idle roles, real-time updates |
| 5 | Component test | SkillForm validates model, tools, delegation inputs |
| 6 | Integration test | Mission-generated tasks inherit roleSlug |

## Resolved Design Decisions

1. **Roles don't belong to missions.** Many-to-many through tasks. Missions express a `defaultRoleSlug` preference, not ownership. Roles are persistent employees, missions are projects.
2. **"Ongoing work" is handled by WATCH/BRIEF missions.** No new concept needed. A Compliance role + a WATCH mission = a persistent responsibility. The mission framework already supports finite and ambient work.
3. **Team page shows current activity.** Not "Builder is assigned to Ship v2" but "Builder is working on X right now." The role's identity comes from its config, not its current mission.

## Key Constants

**Available tools for `allowedTools` chip selector:**
```
Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch, Agent, NotebookEdit
```

**Default color palette for roles:**
```
#C45A3B (terracotta), #5B7BB3 (steel blue), #6B8E5E (olive green),
#D97706 (amber), #8A8478 (warm gray), #9B59B6 (purple),
#2C8C99 (teal), #C4783B (burnt orange)
```

**Model options:**
```
inherit (default), opus, sonnet, haiku
```

## Open Questions

1. **Workspace picker for "+ New Role":** Team page aggregates across workspaces. When user clicks "+ New Role", which workspace? Options: default workspace, modal picker, or most recently used.
2. **Role templates:** Should we ship pre-built roles (Builder, Researcher, Analyst) that users can one-click install? Or start blank?
3. **Role icon vs initial:** Mockup uses first-letter avatar. Could use icons (wrench, magnifying glass, chart) for more visual distinction. Decide during Phase 5.
