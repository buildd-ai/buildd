# Database Patterns

## Schema Conventions

**Location**: `packages/core/db/schema.ts`

### Primary Keys
All tables use UUID with random default:
```ts
id: uuid('id').primaryKey().defaultRandom()
```

### JSONB for Flexible Data
```ts
workspace.memory      // Workspace state
source.config         // Source-specific config
task.context          // Task context
worker.milestones     // Progress milestones array
worker.waitingFor     // User input prompt with options
```

### Indexed Fields
```ts
uniqueIndex('accounts_api_key_idx')   // API key lookup
index('tasks_workspace_idx')          // Task queries
index('tasks_status_idx')             // Status filtering
index('tasks_claimed_by_idx')         // Ownership queries
index('workers_status_idx')           // Active worker queries
```

## Query Patterns

### Eager Loading Relations
```ts
await db.query.tasks.findMany({
  with: { workspace: true, artifacts: true }
});
```

### Lazy Client Initialization
**Location**: `packages/core/db/client.ts`

Uses proxy pattern to avoid Next.js build-time errors:
```ts
// Client not created until first use
export const db = new Proxy(...);
```

## Account Schema (Dual Auth)

```ts
// Common
id, name, email, apiKey, githubId

// API auth (pay-per-token)
anthropicApiKey: text()
maxCostPerDay: decimal()
totalCost: decimal()

// OAuth auth (seat-based)
oauthToken: text()
seatId: text()
maxConcurrentSessions: integer()
activeSessions: integer()

// Shared limits
maxConcurrentWorkers: integer().default(3)
totalTasks: integer().default(0)
```

## Worker Schema (State Machine)

```ts
status: text().default('idle')  // idle|starting|running|waiting_input|completed|error|paused
waitingFor: jsonb()             // { type, prompt, options[] } when waiting_input
progress: integer().default(0)  // 0-100
startedAt: timestamp()          // Set on first running
completedAt: timestamp()        // Set on terminal state
```

## Task Schema (Claiming)

```ts
status: text().default('pending')  // pending|assigned|in_progress|review|completed|failed
claimedBy: uuid().references(accounts.id)
claimedAt: timestamp()
expiresAt: timestamp()             // 15 min from claim
```

## Decimal Handling

Drizzle requires string conversion for decimal fields:
```ts
// Writing
set({ costUsd: costUsd.toString() })

// Comparing (current pattern - suboptimal)
parseFloat(account.totalCost.toString()) >= parseFloat(account.maxCostPerDay.toString())
```

Should use native decimal comparison or Drizzle's decimal operators.
