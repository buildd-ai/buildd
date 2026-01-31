# Distributed Agent Architecture

## Overview

buildd has been enhanced to support **distributed agent execution** - allowing tasks to be claimed and executed by agents running anywhere:

- **Local laptops** (user accounts)
- **Coder workspaces** (team members)
- **GitHub Actions** (CI/CD runners)
- **Dedicated VMs** (service accounts)

The buildd server acts as a **task broker**, coordinating work across this heterogeneous fleet of agents.

## What Changed

### 1. Database Schema

**New Tables:**

```sql
-- Account types: user, service, action
CREATE TABLE accounts (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  github_id TEXT,
  max_concurrent_workers INT DEFAULT 3,
  max_cost_per_day DECIMAL(10,2) DEFAULT 50.00,
  total_cost DECIMAL(10,2) DEFAULT 0,
  total_tasks INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Permissions: which accounts can access which workspaces
CREATE TABLE account_workspaces (
  account_id UUID REFERENCES accounts(id),
  workspace_id UUID REFERENCES workspaces(id),
  can_claim BOOLEAN DEFAULT true,
  can_create BOOLEAN DEFAULT false,
  PRIMARY KEY (account_id, workspace_id)
);
```

**Modified Tables:**

```sql
-- Tasks now have routing preferences and claiming state
ALTER TABLE tasks ADD COLUMN runner_preference TEXT DEFAULT 'any';
ALTER TABLE tasks ADD COLUMN required_capabilities JSONB DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN claimed_by UUID REFERENCES accounts(id);
ALTER TABLE tasks ADD COLUMN claimed_at TIMESTAMPTZ;
ALTER TABLE tasks ADD COLUMN expires_at TIMESTAMPTZ;

-- Workers now belong to accounts
ALTER TABLE workers ADD COLUMN account_id UUID REFERENCES accounts(id);
```

### 2. New API Endpoints

**Account Management:**

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/accounts` | POST | Create account (returns API key) |
| `/api/accounts` | GET | List all accounts |
| `/api/accounts/:id` | GET | Get account details |
| `/api/accounts/:id/workspaces` | POST | Grant workspace access |

**Task Claiming (Agent API):**

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/api/workers/claim` | POST | Bearer token | Claim available tasks |
| `/api/tasks/:id/release` | POST | Bearer token | Release claimed task |

### 3. Agent Package

**New Package:** `packages/agent/`

Lightweight Go binary that:
1. Connects to buildd server with API key
2. Polls `/api/workers/claim` for available tasks
3. Executes tasks locally using Claude SDK
4. Reports progress back to server
5. Repeats

**Files:**
- `main.go` - Entry point and CLI flags
- `client.go` - HTTP client for buildd API
- `runner.go` - Task execution logic
- `README.md` - Usage guide

### 4. Shared Types

**New Enums:**

```typescript
export const AccountType = {
  USER: 'user',
  SERVICE: 'service',
  ACTION: 'action',
} as const;

export const RunnerPreference = {
  ANY: 'any',
  USER: 'user',
  SERVICE: 'service',
  ACTION: 'action',
} as const;
```

**New Interfaces:**

```typescript
interface Account {
  id: string;
  type: AccountTypeValue;
  name: string;
  apiKey: string;
  maxConcurrentWorkers: number;
  maxCostPerDay: number;
  totalCost: number;
  totalTasks: number;
  createdAt: Date;
}

interface ClaimTasksInput {
  workspaceId?: string;
  capabilities?: string[];
  maxTasks?: number;
}

interface ClaimTasksResponse {
  workers: Array<{
    id: string;
    taskId: string;
    branch: string;
    task: Task;
  }>;
}
```

## Task Claiming Flow

```
┌─────────┐                  ┌──────────┐                ┌──────────┐
│  Agent  │                  │  Server  │                │    DB    │
└────┬────┘                  └────┬─────┘                └────┬─────┘
     │                            │                           │
     │ POST /api/workers/claim    │                           │
     │ Authorization: Bearer key  │                           │
     ├────────────────────────────>                           │
     │                            │                           │
     │                            │ Verify API key            │
     │                            ├──────────────────────────>│
     │                            │<──────────────────────────┤
     │                            │ Account details           │
     │                            │                           │
     │                            │ Check permissions         │
     │                            ├──────────────────────────>│
     │                            │<──────────────────────────┤
     │                            │ account_workspaces        │
     │                            │                           │
     │                            │ Find claimable tasks      │
     │                            ├──────────────────────────>│
     │                            │<──────────────────────────┤
     │                            │ Pending tasks             │
     │                            │                           │
     │                            │ Mark as claimed           │
     │                            ├──────────────────────────>│
     │                            │                           │
     │                            │ Create workers            │
     │                            ├──────────────────────────>│
     │                            │                           │
     │<────────────────────────────┤                           │
     │ Workers + task details     │                           │
     │                            │                           │
     │ Start WorkerRunner         │                           │
     │ (execute Claude locally)   │                           │
     │                            │                           │
     │ PATCH /api/workers/:id     │                           │
     │ (progress updates)         │                           │
     ├────────────────────────────>                           │
     │                            │ Update worker status      │
     │                            ├──────────────────────────>│
     │                            │                           │
     │ PATCH /api/workers/:id     │                           │
     │ (completion)               │                           │
     ├────────────────────────────>                           │
     │                            │ Mark task complete        │
     │                            ├──────────────────────────>│
```

## Task Routing Logic

When an agent calls `/api/workers/claim`, the server:

1. **Authenticates** the API key → gets account
2. **Checks limits**:
   - Current active workers < `maxConcurrentWorkers`
   - Today's cost < `maxCostPerDay`
3. **Finds workspaces** the account can claim from (`account_workspaces.can_claim = true`)
4. **Queries tasks** that are:
   - In allowed workspaces
   - Status = `pending`
   - Not claimed OR claim expired
   - `runnerPreference` matches account type (or `any`)
   - `requiredCapabilities` satisfied by agent
5. **Claims tasks**:
   - Sets `claimedBy = account.id`
   - Sets `claimedAt = now()`
   - Sets `expiresAt = now() + 15min`
   - Updates status to `assigned`
6. **Creates workers** for each claimed task
7. **Returns** worker details to agent

## Capabilities System

Tasks can require specific capabilities:

```typescript
// Task requires Node.js 20 and Docker
const task = {
  title: "Deploy API",
  runnerPreference: "action",
  requiredCapabilities: ["node-20", "docker"]
};

// Agent advertises capabilities when claiming
agent.claim({
  capabilities: ["node-20", "docker", "rust", "gpu"]
});
```

Only agents with **all** required capabilities can claim the task.

## GitHub Actions Integration

### Server-Side Trigger

When a task with `runnerPreference: "action"` is created, the server can dispatch a GitHub Action:

```typescript
import { Octokit } from '@octokit/rest';

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

await octokit.repos.createDispatchEvent({
  owner: account.githubId.split('/')[0],
  repo: account.githubId.split('/')[1],
  event_type: 'buildd-task',
  client_payload: {
    task_id: task.id,
    workspace_id: task.workspaceId
  }
});
```

### Action Workflow

```yaml
name: buildd worker
on:
  repository_dispatch:
    types: [buildd-task]

jobs:
  work:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run buildd-agent
        env:
          BUILDD_SERVER: ${{ secrets.BUILDD_SERVER }}
          BUILDD_API_KEY: ${{ secrets.BUILDD_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          curl -fsSL https://buildd.dev/install-agent.sh | bash
          buildd-agent --max-tasks=1
```

## Example: Multi-Account Workflow

### 1. Create Accounts

```bash
# Personal account
curl -X POST http://localhost:3000/api/accounts \
  -d '{"type":"user","name":"Max Laptop"}'
# → api_key: buildd_user_xxxxx

# Service account
curl -X POST http://localhost:3000/api/accounts \
  -d '{"type":"service","name":"Prod Worker","maxConcurrentWorkers":10}'
# → api_key: buildd_svc_xxxxx

# GitHub Action
curl -X POST http://localhost:3000/api/accounts \
  -d '{"type":"action","name":"CI Bot","githubId":"org/repo"}'
# → api_key: buildd_act_xxxxx
```

### 2. Grant Permissions

```bash
# Max can claim from workspace ws-123
curl -X POST http://localhost:3000/api/accounts/acc-user/workspaces \
  -d '{"workspaceId":"ws-123","canClaim":true}'

# Prod worker can claim from multiple workspaces
curl -X POST http://localhost:3000/api/accounts/acc-svc/workspaces \
  -d '{"workspaceId":"ws-123","canClaim":true}'
curl -X POST http://localhost:3000/api/accounts/acc-svc/workspaces \
  -d '{"workspaceId":"ws-456","canClaim":true}'
```

### 3. Create Tasks with Routing

```bash
# General task - any agent can pick up
curl -X POST http://localhost:3000/api/tasks \
  -d '{"workspaceId":"ws-123","title":"Add tests","runnerPreference":"any"}'

# Deterministic task - only GH Actions
curl -X POST http://localhost:3000/api/tasks \
  -d '{"workspaceId":"ws-123","title":"Deploy prod","runnerPreference":"action"}'

# Creative task - only humans
curl -X POST http://localhost:3000/api/tasks \
  -d '{"workspaceId":"ws-123","title":"Design API","runnerPreference":"user"}'
```

### 4. Run Agents

```bash
# On Max's laptop
export BUILDD_API_KEY=buildd_user_xxxxx
buildd-agent --workspace=ws-123 --max-tasks=2

# On dedicated VM
export BUILDD_API_KEY=buildd_svc_xxxxx
buildd-agent --max-tasks=10

# GitHub Action runs automatically when dispatched
```

## Migration Path

To migrate existing buildd installations:

1. **Generate new migration:**
   ```bash
   pnpm db:generate
   ```

2. **Review migration SQL** in `packages/server/drizzle/`

3. **Run migration:**
   ```bash
   pnpm db:migrate
   ```

4. **Create initial accounts:**
   - Create a "default" service account
   - Grant it access to all existing workspaces
   - Optionally: Create user accounts for team members

5. **Update workers:**
   - Backfill `account_id` on existing workers (optional)

## Security Considerations

1. **API Keys**
   - Generated as `buildd_{type}_{hex}` (64 chars)
   - Stored as-is (consider hashing in production)
   - Transmitted via `Authorization: Bearer` header

2. **Permissions**
   - Accounts can only claim from workspaces they have access to
   - `can_claim` vs `can_create` separation
   - Per-account limits enforced server-side

3. **Task Expiry**
   - Claims expire after 15 minutes
   - Tasks auto-release if agent doesn't start work
   - Prevents claim hoarding

4. **Rate Limiting**
   - `maxConcurrentWorkers` prevents resource exhaustion
   - `maxCostPerDay` prevents runaway costs
   - Server tracks `totalCost` and `totalTasks` per account

## Future Enhancements

- [ ] WebSocket connections (push tasks instead of polling)
- [ ] Agent heartbeat/health monitoring
- [ ] Task priorities and SLA tracking
- [ ] Account teams/organizations
- [ ] Fine-grained permissions (read-only, admin, etc.)
- [ ] Agent capability auto-detection
- [ ] Cost budgets per workspace
- [ ] Task dependencies (block/unblock chains)
