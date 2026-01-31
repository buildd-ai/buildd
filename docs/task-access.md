# Task Access Model (Plan B: Split Roles)

## Overview

Separate **Dashboard Users** (task creators/managers) from **Workers** (task executors). Workers can be machines (tokens) or humans (contractors), and don't need dashboard access.

## Roles

### Dashboard Users
- Authenticate via Google or GitHub OAuth
- Create and manage workspaces
- Create and prioritize tasks
- View worker progress and results
- Manage billing and settings

### Workers
Two types, same interface:

| | Machine Workers | Human Workers |
|---|---|---|
| Identity | API token (`bld_xxx`) | GitHub account |
| Auth | Bearer token | GitHub OAuth (worker flow) |
| Repo access | Via deploy keys or GitHub App | Native GitHub permissions |
| Interface | MCP server / API | Worker portal (future) |
| Use case | CI/CD, Claude Code, automation | Contractors, freelancers |

## Data Model

```sql
-- Dashboard users (existing auth)
users
  id              uuid primary key
  email           text unique
  name            text
  image           text
  googleId        text            -- Google OAuth
  githubId        text            -- Optional GitHub link (for repo verification)
  role            text            -- 'admin' | 'member'
  createdAt       timestamp

-- Worker accounts (machines)
accounts                          -- existing table
  id              uuid primary key
  name            text
  type            text            -- 'service' | 'action' | 'user'
  apiKey          text unique     -- bld_xxx
  ...

-- Human workers (new)
human_workers
  id              uuid primary key
  githubId        bigint unique   -- GitHub user ID
  githubUsername  text
  githubAvatarUrl text
  email           text
  displayName     text
  status          text            -- 'active' | 'suspended' | 'pending'
  createdAt       timestamp
  lastActiveAt    timestamp

-- Unified worker assignment
-- Tasks can be claimed by either account (machine) or human_worker
tasks
  ...
  claimedByAccount    uuid references accounts(id)
  claimedByHuman      uuid references human_workers(id)
  -- constraint: only one can be set
```

## Access Control

### Workspace Access

```
workspaces.accessMode: 'open' | 'restricted'

For machines (tokens):
  - open: any token can claim
  - restricted: check accountWorkspaces.canClaim

For humans:
  - Check GitHub repo access via API
  - Or explicit humanWorkerWorkspaces permission
```

### Task Visibility

```
Dashboard users:  See all tasks in their workspaces
Machine workers:  See tasks from permitted workspaces (via MCP/API)
Human workers:    See only tasks they can claim (workspace + repo access)
```

## Flows

### Machine Worker Flow (existing)
```
1. Token created in dashboard
2. Token linked to workspace (if restricted)
3. Machine calls claim API with token
4. Machine executes task
5. Machine reports completion
```

### Human Worker Flow (new)
```
1. Contractor receives invite link: buildd.dev/work/invite/{code}
2. Contractor authenticates with GitHub
3. System checks GitHub permissions for workspace repo
4. Contractor sees available tasks
5. Contractor claims task → creates branch
6. Contractor works (locally or Codespace)
7. Contractor submits PR via buildd
8. Task marked for review
```

### Invite Flow
```
Dashboard user creates invite:
  - Workspace scope (or specific tasks)
  - Expiry
  - Max tasks
  - Rate/payment terms (future)

Generates link: buildd.dev/work/invite/abc123

Contractor clicks → GitHub OAuth → sees tasks
```

## Task Types

```sql
tasks.type: 'code' | 'review' | 'design' | 'advisory'

code:     Requires repo write access, creates branch
review:   Requires repo read access, comments only
design:   No repo access, uploads artifacts
advisory: No repo access, text response only
```

## Worker Portal (Future)

Minimal UI for human workers:
- `/work` - Available tasks
- `/work/active` - Claimed tasks
- `/work/history` - Completed tasks
- No workspace management, no billing, no settings

## API Changes

### New Endpoints

```
POST /api/workers/human/auth     -- GitHub OAuth for workers
GET  /api/workers/human/tasks    -- Tasks available to human worker
POST /api/workers/human/claim    -- Human claims task
POST /api/invites                -- Create worker invite
GET  /api/invites/{code}         -- Validate invite
```

### Modified Endpoints

```
GET  /api/tasks                  -- Add ?workerType=human|machine filter
POST /api/workers/claim          -- Support human worker claims
```

## Migration Path

1. **Phase 1** (current): Machine workers only, workspace accessMode
2. **Phase 2**: Add human_workers table, GitHub OAuth for workers
3. **Phase 3**: Worker portal UI, invite system
4. **Phase 4**: Task types, payment integration

## Open Questions

- [ ] Should human workers see task descriptions before claiming?
- [ ] Rate limiting for human workers (max concurrent tasks)?
- [ ] How to handle workers without GitHub repo access? (fork model?)
- [ ] Payment/billing integration timeline?
- [ ] Do we verify GitHub access on every claim or cache it?
