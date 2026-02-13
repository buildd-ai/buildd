# Buildd Architecture Context (Internal)

## Dual Auth Model - Billing Abstraction

Two parallel auth strategies with **different limiting mechanisms**:

| Auth Type | Limiting Strategy | Fields |
|-----------|-------------------|--------|
| `api` | Cost-based | `maxCostPerDay`, `totalCost` |
| `oauth` | Session-based | `maxConcurrentSessions`, `activeSessions` |

The `authType` field determines which limit checks run in `/api/workers/claim`. This isn't just auth - it's how you bill differently for pay-per-token vs seat-based licensing.

## Workers Are Database Entities

Workers aren't processes - they're first-class DB records:

```
POST /claim → creates worker record → task.status = "assigned"
                    ↓
           worker executes externally
                    ↓
PATCH /workers/[id] → updates progress → triggers Pusher
                    ↓
           completion → task.status = "completed"
```

The API is a **coordination layer**. Workers run externally and report back.

## State Machines

### Task States
```
pending → assigned → in_progress → completed
      ↘              ↘           ↗
                      → failed
```
- Only `pending` or expired claims can be claimed
- 15-minute claim expiry window (but no background cleanup job - see tech-debt)

### Worker States
```
idle → starting → running ─┬─→ completed
                  ↑        └─→ error
                  └─ waiting_input (blocks on AskUserQuestion)
```

## Capability-Based Task Matching

Tasks specify `requiredCapabilities` and `preferredRunner`. Workers declare capabilities. Claim endpoint matches:

```ts
// Simplified - actual logic in /api/workers/claim
findMany({
  where: and(
    eq(tasks.status, 'pending'),
    // capability intersection check
  )
})
```

Enables heterogeneous worker pools (GitHub access, specific tools, etc.)

## MCP Server = Claude as Worker

`apps/mcp-server` exposes buildd as Claude tools:
- `buildd_claim_task` - Claude claims work
- `buildd_update_progress` - Reports during execution
- `buildd_complete_task` / `buildd_fail_task` - Lifecycle

Creates a loop: humans create tasks → Claude claims → executes → results flow back.

## Vercel Constraint

Vercel functions timeout at 10-60s. Claude execution takes 1-5+ minutes.

**Decision**: Vercel hosts API/dashboard (coordination), workers run externally (execution). `apps/agent` is designed for this.

## Cost Tracking Flow

```
worker PATCH /workers/[id] with costUsd
        ↓
worker-runner.ts adds to account.totalCost (if authType='api')
        ↓
next claim checks totalCost >= maxCostPerDay → 429
```

Cost tracked per-account, not per-workspace. Multiple workspaces share budget.

## Security Hooks

Worker execution validates commands/files before allowing:

```ts
// packages/core/worker-runner.ts - PreToolUse hook
DANGEROUS_PATTERNS = [/rm\s+-rf/, /sudo/, /curl.*\|\s*sh/, ...]
SENSITIVE_PATHS = [/\.env$/, /\.ssh\//, /id_rsa/, ...]
```

Returns `deny` decision to block dangerous operations.
