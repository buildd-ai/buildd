# Git Workflow Configuration - Implementation Summary

## Overview

This implementation adds workspace-level git workflow configuration to Buildd. Admins can now configure how agents should handle git operations (branching, commits, PRs) for each workspace, rather than having a hardcoded `buildd/` branch prefix.

## Changes Made

### 1. Database Schema (`packages/core/db/schema.ts`)

Added to `workspaces` table:
- `gitConfig` (jsonb) - Stores the git workflow configuration
- `configStatus` (text) - Enum: `'unconfigured'` | `'admin_confirmed'`

```typescript
interface WorkspaceGitConfig {
  defaultBranch: string;              // 'main', 'dev', etc.
  branchingStrategy: 'none' | 'trunk' | 'gitflow' | 'feature' | 'custom';
  branchPrefix?: string;              // 'feature/', null for none
  useBuildBranch?: boolean;          // Use buildd/task-id naming
  commitStyle: 'conventional' | 'freeform' | 'custom';
  commitPrefix?: string;
  requiresPR: boolean;
  targetBranch?: string;
  autoCreatePR: boolean;
  agentInstructions?: string;         // Prepended to every task prompt
  useClaudeMd: boolean;               // Whether to load CLAUDE.md
}
```

### 2. Migration Generated

File: `packages/core/drizzle/0008_special_caretaker.sql`

### 3. API Endpoint (`apps/web/src/app/api/workspaces/[id]/config/route.ts`)

- `GET` - Fetch workspace git config
- `POST` - Save workspace git config (sets `configStatus` to `'admin_confirmed'`)

### 4. Worker Updates (`apps/local-ui/src/workers.ts`)

- Fetches workspace config from server before starting task
- Builds prompt with:
  1. Admin-defined `agentInstructions` (if configured)
  2. Git workflow context (default branch, branching strategy, PR requirements)
  3. Task description
  4. Task metadata
- Conditionally loads `CLAUDE.md` based on `useClaudeMd` setting

### 5. Claim Route Updates (`apps/web/src/app/api/workers/claim/route.ts`)

- Branch naming now respects `gitConfig`:
  - If `useBuildBranch: true` → uses `buildd/task-id-title`
  - If `branchPrefix` set → uses `${prefix}task-id-title`
  - Default fallback → `buildd/task-id-title` (backwards compatible)

### 6. Dashboard UI

New config page: `/workspaces/[id]/config`
- Form to configure all git workflow settings
- Link added to workspace detail page ("⚙️ Configure" button)

## Flow

1. Admin adds workspace → workspace created with `configStatus: 'unconfigured'`
2. Admin clicks "Configure" on workspace → opens config form
3. Admin fills out form and saves → `configStatus: 'admin_confirmed'`
4. When agent claims task:
   - Server generates branch name based on `gitConfig`
   - Worker fetches config and builds context-aware prompt
5. Agent executes with full awareness of project conventions

## Defaults (when unconfigured)

- Branch: `buildd/task-id-title` (backwards compatible)
- CLAUDE.md: Loaded by default
- No additional agent instructions
- Agent follows its own judgment for git operations

## Testing

To test:
1. Run migration: `cd packages/core && bun db:migrate`
2. Start web app and navigate to a workspace
3. Click "Configure" and set up git workflow
4. Create a task and observe the agent prompt includes git context

## Future Enhancements

- Lightweight hint on config page (detect default branch from .git/HEAD)
- Auto-scan task to suggest configuration (deferred for now)
- Branch reporting from agent back to server
