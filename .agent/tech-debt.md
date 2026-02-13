# Tech Debt & Known Issues

## Critical

### Missing Transaction Boundaries
**Location**: `apps/web/src/app/api/workers/claim/route.ts:131-156`

Task claim + worker creation not wrapped in transaction:
```ts
// If worker insert fails after task update, task stays "assigned" forever
await db.update(tasks)...  // Task marked assigned
await db.insert(workers)... // Could fail here
```

**Fix**: Wrap in `db.transaction()`.

### Cost Tracking Race Conditions
**Location**: `packages/core/worker-runner.ts:140-145`

Two workers completing simultaneously could race on `totalCost` update:
```ts
await db.update(accounts)
  .set({ totalCost: sql`${accounts.totalCost} + ${costUsd}` })
```

**Fix**: Use `FOR UPDATE` row lock or atomic increment.

### Claim Expiry Not Enforced
**Location**: `apps/web/src/app/api/workers/claim/route.ts:101`

Code checks for expired claims, but no background job to auto-unclaim:
- Hung tasks stay "assigned" forever if worker dies
- Manual intervention required

**Fix**: Cron job to reset expired claims, or check on GET.

## Medium

### Type Coercion Issues
**Location**: `apps/web/src/app/api/accounts/route.ts:63`
```ts
authType: authType as 'api' | 'oauth' || 'oauth'  // || doesn't work here
```

**Location**: `workers/claim/route.ts:52`
```ts
parseFloat(account.totalCost.toString()) >= parseFloat(...)
```
String-to-number for decimal comparison. Should use native decimal.

### Promise Swallowing
**Location**: `apps/agent/src/agent.ts:82-88`
```ts
runner.start().catch(...)  // Called without await, errors swallowed
```

**Fix**: Await and handle properly.

### Command Validation Weak
**Location**: `apps/web/src/app/api/workers/[id]/cmd/route.ts:45-52`
```ts
const validActions = ['pause', 'resume', 'abort', 'message'];
if (!validActions.includes(action)) ...
```

No schema validation. No enum. No validation on `text` payload.

## Low

### Missing Idempotency
POST endpoints not idempotent. No `Idempotency-Key` header. Retries create duplicates.

### No Structured Logging
Heavy `console.error()` / `console.log()`. No JSON format, timestamps, trace IDs.

### Permissions Too Coarse
`accountWorkspaces` only has `canClaim` / `canCreate`. No read restrictions, no audit logging.

### No OpenAPI Spec
Endpoint contracts only in types.ts and implementation. Hard to generate SDKs.

## Patterns to Avoid

When adding new endpoints:
- Don't return different mock shapes in dev mode
- Don't use `as Type` without validation
- Don't do multi-step DB operations without transactions
- Don't swallow promise rejections
