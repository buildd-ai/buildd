# Agent Roles & Team Management — Architecture

> A role is a workspace. Not a DB row with extra columns — a configured environment that an agent runs in.

## The Insight

The runner already knows how to:
- Read `.claude/skills/` and make skills available via `Skill()` tool
- Read `.mcp.json` and connect to MCP servers automatically (SDK autodiscovery)
- Inherit env vars from the process (making connectors actually work)
- Run in a working directory with memory, git, etc.
- Sync skill bundles from server → local disk with hash-based caching (`syncSkillToLocal`)
- Download files from R2 via presigned URLs (used for attachments today)

A "role" is just **a workspace directory configured for a specific agent persona.** The DB row tracks metadata (name, color, status). The directory does the real work.

---

## Two Types of Roles

| | Builder roles | Service roles |
|---|---|---|
| **Has git repo** | Yes — existing cloned repo | No — just a config directory |
| **Source code** | Yes | No |
| **MCP servers** | github, linear, etc. | slack, stripe, quickbooks, etc. |
| **Skills** | buildd-workflow, code-review | financial-analysis, email-templates |
| **Working dir** | The repo itself (resolved by WorkspaceResolver) | `~/.buildd/roles/<slug>/` |
| **Example** | Builder, QA | Finance, Comms, Researcher |

**Builder roles** overlay config onto an existing repo. The repo is already cloned (WorkspaceResolver finds it). The role adds `.mcp.json`, env vars, and skills on top.

**Service roles** get their own standalone directory. No repo needed. They work through MCP connectors (Stripe, Slack, etc.) and produce output in their working dir.

---

## Role Workspace Directory Structure

```
~/.buildd/roles/
├── builder/                    ← overlay on existing repo
│   ├── .mcp.json              ← additional connectors (merged with repo's)
│   ├── .env                   ← GITHUB_TOKEN, LINEAR_API_KEY
│   └── .claude/
│       └── skills/            ← role-specific skills
│
├── finance/                    ← standalone workspace
│   ├── CLAUDE.md              ← "You are Finance, you monitor..."
│   ├── .mcp.json              ← quickbooks, stripe connectors
│   ├── .env                   ← STRIPE_API_KEY, QB_TOKEN
│   ├── .claude/
│   │   └── skills/
│   │       └── financial-analysis/
│   └── data/                  ← working directory for outputs
│
├── researcher/
│   ├── CLAUDE.md
│   ├── .mcp.json              ← web-search, buildd-memory
│   └── .claude/
│       └── skills/
│
└── comms/
    ├── CLAUDE.md
    ├── .mcp.json              ← slack, gmail, calendar
    ├── .env                   ← SLACK_TOKEN, GMAIL_TOKEN
    └── .claude/
        └── skills/
```

### The role's identity

`CLAUDE.md` in the role's workspace IS the role definition. Not a DB column — a file in a directory. The runner already reads `CLAUDE.md` from cwd.

For builder roles, the repo's own `CLAUDE.md` provides project context. The role's overlay adds persona-specific instructions.

---

## How It Works End-to-End

### Config sync: Web UI → R2 → Runner

The web UI runs on Vercel. Role workspaces live on the runner. **R2 bridges the gap** — same infrastructure already used for attachments.

```
CREATE / UPDATE (rare — only when user edits role config)
┌─────────────────┐    ┌──────────────┐    ┌──────────┐
│ Role Editor      │───▶│ API          │───▶│ R2       │
│ (web UI)         │    │              │    │          │
│ Saves:           │    │ 1. Update DB │    │ Stores   │
│ - CLAUDE.md      │    │ 2. Package   │    │ config   │
│ - .mcp.json      │    │    tarball   │    │ tarball  │
│ - env mappings   │    │ 3. Upload    │    │          │
│ - skills refs    │    │    to R2     │    │          │
│ - model/tools    │    │ 4. Store     │    │          │
│                  │    │    R2 key +  │    │          │
│                  │    │    hash on   │    │          │
│                  │    │    DB row    │    │          │
└─────────────────┘    └──────────────┘    └──────────┘

TASK CLAIM (every task — but lightweight, usually no download)
┌──────────────────┐    ┌──────────────┐    ┌──────────┐
│ Claim route      │───▶│ Runner       │───▶│ Exec     │
│ returns:         │    │              │    │          │
│ - roleSlug       │    │ 1. Check     │    │ cwd =    │
│ - configHash     │    │    local     │    │ role     │
│ - R2 presigned   │    │    .buildd-  │    │ workspace│
│   URL (if new)   │    │    hash      │    │ dir      │
│                  │    │ 2. If stale: │    │          │
│                  │    │    download  │    │          │
│                  │    │    + extract │    │          │
│                  │    │ 3. Set cwd   │    │          │
└──────────────────┘    └──────────────┘    └──────────┘
```

**Key:** Config transfers happen only on create/update. The runner caches with `.buildd-hash`. On a typical task claim, the runner just checks the hash and skips the download.

This is the **exact same pattern** as `syncSkillToLocal()` in `apps/runner/src/skills.ts` — which already writes to `~/.claude/skills/<slug>/` with hash-based caching.

### Task execution flow

```
Runner claims task with roleSlug="finance"
  → Check ~/.buildd/roles/finance/.buildd-hash vs configHash from claim
  → If stale: download tarball from R2 presigned URL, extract
  → Set queryOptions.cwd = ~/.buildd/roles/finance/
  → SDK discovers CLAUDE.md → system prompt
  → SDK discovers .mcp.json → connects to stripe, quickbooks
  → Process env includes .env vars → STRIPE_API_KEY works
  → SDK discovers .claude/skills/ → financial-analysis available
  → Agent executes task
```

For builder roles, the flow adds a workspace resolution step:
```
Runner claims task with roleSlug="builder"
  → Resolve repo via WorkspaceResolver (existing logic)
  → Sync role overlay config to repo directory (or use worktree)
  → Set queryOptions.cwd = resolved repo path
  → SDK discovers repo's CLAUDE.md + role's overlay
  → Agent executes in the repo
```

---

## Data Model

### DB: `workspaceSkills` table (existing, extended)

Fields that stay (runner uses them at SDK level, not file-based):
- `id`, `workspaceId`, `slug`, `name`, `description`, `enabled`
- `model` — per-agent model override (runner line 2187) ✓
- `allowedTools` — tool restriction (runner line 2174) ✓
- `canDelegateTo` — Task() delegation (runner line 2179) ✓
- `background` — background execution flag (runner line 2191) ✓
- `maxTurns` — per-agent turn limit (runner line 2193) ✓
- `color` — avatar color for UI
- `origin`, `metadata`, `createdAt`, `updatedAt`

Fields to add:
- `configHash` — SHA-256 of the packaged tarball, for cache invalidation
- `configStorageKey` — R2 object key for the role config tarball
- `isRole` — boolean, distinguishes roles (Team page) from skills (building blocks)
- `repoUrl` — optional, for builder roles (git clone target)

Fields to deprecate (replaced by files in the workspace):
- `content` — replaced by `CLAUDE.md` in workspace dir
- `mcpServers` — replaced by `.mcp.json` in workspace dir
- `requiredEnvVars` — replaced by `.env` in workspace dir

Keep these columns for backward compat but stop using them for roles. Skills (non-role entries) still use `content`.

### R2 tarball contents

```
role-config.tar.gz
├── CLAUDE.md              ← persona / instructions
├── .mcp.json              ← MCP server config (connectors)
├── env-mapping.json       ← { "STRIPE_API_KEY": "stripe-prod-key" }
│                            (secret label → runner resolves to actual value)
├── .claude/
│   └── skills/
│       └── <slug>/
│           └── SKILL.md   ← referenced skill content (inlined at package time)
└── .buildd-role.json      ← metadata: slug, version, type (builder|service)
```

**Note on secrets:** The tarball contains env var NAME → SECRET LABEL mappings, not actual secret values. The runner resolves labels to values from its own env or a secrets manager. This keeps secrets out of R2.

### Claim route response (extended)

```typescript
interface ClaimWorkerResponse {
  // ... existing fields ...

  // Role config (new)
  roleConfig?: {
    slug: string;
    configHash: string;
    configUrl: string;        // R2 presigned download URL
    type: 'builder' | 'service';
    repoUrl?: string;         // For builder roles
    // DB-level config (not in tarball — runner uses directly)
    model: string;
    allowedTools: string[];
    canDelegateTo: string[];
    background: boolean;
    maxTurns: number | null;
  };
}
```

---

## Implementation Plan

### Phase 2A: Schema + Config Packaging

**Goal:** Role Editor saves config to R2 tarball. DB tracks hash + storage key.

1. **Migration:** Add `configHash`, `configStorageKey`, `isRole`, `repoUrl` to `workspaceSkills`
2. **Migration:** Set `isRole = true` for existing consolidated roles (builder, researcher, ops, finance, comms)
3. **Package function** (`apps/web/src/lib/role-config.ts` — NEW):
   - Takes role config (CLAUDE.md content, .mcp.json, env mappings, skill slugs)
   - Resolves skill slugs → fetches their content from DB
   - Packages into tarball
   - Uploads to R2 via existing `generateUploadUrl`
   - Returns `{ configHash, configStorageKey }`
4. **Role PATCH route:** On save, call packager, update DB with hash + key
5. **Role POST route:** On create, call packager, set `isRole = true`

**Files:**
- `packages/core/db/schema.ts` — add columns
- `apps/web/src/lib/role-config.ts` — NEW, tarball packager
- `apps/web/src/app/api/workspaces/[id]/skills/route.ts` — POST creates role config
- `apps/web/src/app/api/workspaces/[id]/skills/[skillId]/route.ts` — PATCH updates role config

### Phase 2B: Claim Route + Runner Sync

**Goal:** Runner receives role config on claim, syncs to local disk, sets cwd.

1. **Claim route enrichment:** When task has `roleSlug`, look up role's `configHash` + generate presigned download URL. Include in response as `roleConfig`.
2. **Runner: `syncRoleToLocal()`** (`apps/runner/src/roles.ts` — NEW):
   - Same pattern as `syncSkillToLocal()` in `apps/runner/src/skills.ts`
   - Check `~/.buildd/roles/<slug>/.buildd-hash` vs `configHash`
   - If stale: download tarball from presigned URL, extract to `~/.buildd/roles/<slug>/`
   - Resolve env mappings: read `env-mapping.json`, look up values from `process.env` or runner config
   - Write `.env` with resolved values
3. **Runner: per-role cwd** (`apps/runner/src/workers.ts`):
   - If task has `roleSlug` and role type is `service`: `queryOptions.cwd = ~/.buildd/roles/<slug>/`
   - If task has `roleSlug` and role type is `builder`: resolve repo via WorkspaceResolver, overlay role config
   - If no `roleSlug`: use existing workspace resolution (unchanged)

**Files:**
- `apps/web/src/app/api/workers/claim/route.ts` — enrich with roleConfig
- `apps/runner/src/roles.ts` — NEW, role workspace sync
- `apps/runner/src/workers.ts` — per-role cwd switching

### Phase 2C: Team Page + Role Editor Updates

**Goal:** Team page shows only roles. Role Editor manages files, not just DB fields.

1. **Team page:** Filter by `isRole = true` — no more showing every skill as a team member
2. **Role Editor:**
   - Instructions textarea → reads/writes to `CLAUDE.md` content (stored in DB, packaged to R2 on save)
   - Connectors section → reads/writes `.mcp.json` structure (stored in DB as structured JSON, packaged on save)
   - Environment section → reads/writes env mappings (stored in DB, packaged on save)
   - Skills section → chip selector of other workspace skills (slugs stored in DB, content inlined at package time)
   - On "Save Changes": package tarball → upload to R2 → update DB hash + key
3. **"+ New Role" from Team page:** Creates a service role by default. Option to select "Builder role" which prompts for repo URL.

**Files:**
- `apps/web/src/app/app/(protected)/team/page.tsx` — filter `isRole = true`
- `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx` — file-backed editing
- `apps/web/src/app/app/(protected)/workspaces/[id]/skills/[skillId]/page.tsx` — pass skill options

### Phase 2D: Global Roles

**Goal:** Roles are account-level, not workspace-scoped. No more duplicates.

1. **New `roles` table** (or `accountId` on `workspaceSkills`):
   - `accountId` instead of `workspaceId`
   - Role config is account-global
   - Tasks still belong to workspaces — `roleSlug` routes to the right role
2. **Team page:** Shows roles for the account, not per-workspace
3. **Workspace override:** A workspace can have a `workspaceSkills` entry with the same slug that overrides the account-level role for that workspace

**Defer this phase** — start with workspace-scoped roles, promote to account-level once the core works.

---

## Runner Audit Results (verified)

| Field | Runner uses it? | How |
|-------|----------------|-----|
| `model` | **YES** | Line 2187: `model: bundle.model \|\| 'inherit'` |
| `allowedTools` | **YES** | Line 2174: filters agent tools |
| `canDelegateTo` | **YES** | Line 2179: injects `Task(<slug>)` tools |
| `background` | **YES** | Line 2191: background agent flag |
| `maxTurns` | **YES** | Line 2193: per-agent turn limit |
| `mcpServers` | **NO** | Never read — SDK autodiscovers from `.mcp.json` |
| `requiredEnvVars` | **NO** | Never read — runner uses process env |

### Existing runner infrastructure we leverage

- **WorkspaceResolver** (`apps/runner/src/workspace.ts`): Auto-discovers local repos by git remote, name, path. Used for builder roles.
- **`syncSkillToLocal()`** (`apps/runner/src/skills.ts`): Writes skill bundles to `~/.claude/skills/<slug>/` with `.buildd-hash` caching. Template for `syncRoleToLocal()`.
- **R2 presigned URLs**: Already generated in claim route for attachments (line 417-432). Same mechanism for role config tarballs.
- **Per-task cwd**: Already supported — `queryOptions.cwd` is set per worker session (line 2229).
- **Worktree isolation**: Production-grade per-task branching. Builder roles can use this for isolation.
- **Secret injection**: Claim route already decrypts and passes API keys, OAuth tokens, MCP credentials (lines 498-547).

---

## What Success Looks Like

1. You create "Finance" role from the Team page
2. Add `.mcp.json` with Stripe + QuickBooks connectors
3. Add `STRIPE_API_KEY` → `stripe-prod-key` env mapping
4. Save → tarball uploaded to R2
5. A WATCH mission creates a daily task with `roleSlug: "finance"`
6. Runner claims task, checks hash, downloads config (first time only)
7. Runner `cd`s to `~/.buildd/roles/finance/`
8. SDK reads `CLAUDE.md`, discovers `.mcp.json`, loads env vars
9. Agent talks to Stripe, produces a report
10. Result shows up in the dashboard

**For a builder role:** Same flow but `cwd` = the repo directory (resolved by WorkspaceResolver). Agent has repo context + role-specific connectors and instructions.

---

## Shipped (Phase 1 — Live in Production)

- Schema: `model`, `allowedTools`, `canDelegateTo`, `background`, `maxTurns`, `color`, `mcpServers`, `requiredEnvVars` on `workspaceSkills`
- `tasks.roleSlug`, `objectives.defaultRoleSlug`
- Team page (`/app/team`), Role Editor (`/app/workspaces/[id]/skills/[skillId]`), Home page team section
- Mission form: "Assign to role" chip selector
- Navigation: Team in sidebar + bottom nav
- Runner: uses model, allowedTools, canDelegateTo, background, maxTurns from skill bundles
- Runner: ignores mcpServers, requiredEnvVars (replaced by file-based config in Phase 2)
- DB: 5 consolidated roles (builder, researcher, ops, finance, comms) in primary workspace
- DB: 15 legacy granular skills disabled (not deleted)

## Shipped (Phase 2 — Implemented, Pending Deploy)

### Phase 2A: Schema + Config Packaging
- Schema: `isRole`, `configHash`, `configStorageKey`, `repoUrl` on `workspaceSkills`
- Migration 0018: adds columns + data migration sets `isRole=true` for 5 consolidated roles
- `role-config.ts`: packages role config as JSON bundle, uploads to R2
- `storage.ts`: added `uploadBuffer()` for direct server-side R2 uploads
- API routes: PATCH/POST/DELETE handle role config packaging and R2 lifecycle

### Phase 2B: Claim Route + Runner Sync
- Claim route: enriches response with `roleConfig` (presigned download URL, DB-level config)
- `roles.ts` (runner): `syncRoleToLocal()` with hash-based caching, `resolveRoleEnv()`, `overlayRoleFiles()`
- `workers.ts`: service roles use `~/.buildd/roles/<slug>/` as cwd; builder roles overlay files into repo
- Shared types: `RoleConfig` interface in `@buildd/shared`

### Phase 2C: Team Page + Role Editor
- Team page: filters `isRole=true`, queries account-level roles
- RoleEditor: "Show on Team page" toggle, conditional "Repo URL" field
- `isRole`/`repoUrl` flow through API to DB

### Phase 2D: Global Roles
- Schema: `accountId` on `workspaceSkills` (nullable, migration 0019)
- Team page: queries both workspace-scoped and account-level roles
- Claim route: workspace-level role lookup with account-level fallback
- API routes: accept `accountId` in POST/PATCH

### Known gaps (future work)
- Skills chip selector UI in RoleEditor (selecting which skills a role references)
- Full MCP config editor (currently `mcpConfig` is empty; MCP names handled by skill bundle system)
- `.mcp.json` overlay for builder roles only works when role has valid MCP config objects
