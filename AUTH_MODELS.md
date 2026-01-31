# Authentication Models: OAuth vs API

buildd supports **two authentication methods** for Claude execution, each with different cost models and use cases.

## Overview

| Model | Auth Mechanism | Cost Structure | Limits | Best For |
|-------|----------------|----------------|--------|----------|
| **OAuth** | `CLAUDE_CODE_OAUTH_TOKEN` | Seat-based (fixed monthly) | Concurrent sessions | Team members, personal use |
| **API** | `ANTHROPIC_API_KEY` | Pay-per-token (variable) | Daily cost cap | Production, CI/CD, scale |

## OAuth Authentication (Seat-Based)

### How It Works

Uses your **Claude Pro or Team subscription** seat. Claude execution happens via the `claude` CLI with OAuth token authentication.

```bash
# User authenticates once
claude auth

# Agent uses OAuth token
export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)
./buildd-agent
```

### Cost Model

- **Fixed cost**: Included in Claude Pro ($20/mo) or Team ($30/mo per seat)
- **No per-token charges**: Unlimited usage within fair use policy
- **No tracking needed**: Server doesn't track costs for OAuth accounts

### Limits

- **Concurrent sessions**: Typically 1-3 per seat
  - Server tracks `activeSessions` count
  - Incremented when worker claims task
  - Decremented when worker completes
- **Fair use**: Anthropic's usage policies apply

### Use Cases

✅ **Personal laptops** - Use your own Claude Pro seat
✅ **Team workspaces** - Team members in Coder
✅ **Development/testing** - No cost concerns
✅ **Low concurrency** - 1-3 tasks at a time

❌ **High scale** - Limited by seat count
❌ **CI/CD** - Ephemeral runners can't authenticate
❌ **Cost tracking** - No per-task cost attribution

### Account Creation

```bash
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "user",
    "name": "Max Laptop",
    "authType": "oauth",
    "oauthToken": "oauth_xxxxx",
    "seatId": "seat-123",
    "maxConcurrentSessions": 1,
    "maxConcurrentWorkers": 3
  }'
```

### Server Behavior

**On task claim:**
```typescript
if (account.authType === 'oauth') {
  // Check session limit
  if (account.activeSessions >= account.maxConcurrentSessions) {
    return 429; // Too many sessions
  }

  // Increment session count
  account.activeSessions += claimedTasks.length;
}
```

**On worker completion:**
```typescript
if (worker.account.authType === 'oauth') {
  // Decrement session count
  account.activeSessions -= 1;

  // Track task count only (no cost)
  account.totalTasks += 1;
}
```

## API Authentication (Pay-Per-Token)

### How It Works

Uses **Anthropic API** with a dedicated API key. Billed per input/output token.

```bash
# Agent uses API key directly
export ANTHROPIC_API_KEY=sk-ant-xxxxx
./buildd-agent
```

### Cost Model

- **Variable cost**: Charged per token (~$3/$15 per million tokens for Sonnet)
- **Granular tracking**: Server tracks `totalCost` per account
- **Daily caps**: Configurable `maxCostPerDay` limit

### Limits

- **Cost-based**: `totalCost < maxCostPerDay`
  - Server tracks cumulative cost
  - Resets daily (or manually)
- **Worker-based**: `activeWorkers < maxConcurrentWorkers`

### Use Cases

✅ **Production workloads** - Dedicated service accounts
✅ **GitHub Actions** - Ephemeral CI/CD runners
✅ **High scale** - 10+ concurrent workers
✅ **Cost attribution** - Track per-task costs
✅ **Guaranteed capacity** - Not limited by seats

❌ **Small teams** - More expensive than seats for light use
❌ **Personal use** - Pay extra beyond Pro subscription

### Account Creation

```bash
curl -X POST http://localhost:3000/api/accounts \
  -H "Content-Type: application/json" \
  -d '{
    "type": "service",
    "name": "Prod Worker",
    "authType": "api",
    "anthropicApiKey": "sk-ant-xxxxx",
    "maxCostPerDay": 500,
    "maxConcurrentWorkers": 10
  }'
```

### Server Behavior

**On task claim:**
```typescript
if (account.authType === 'api') {
  // Check cost limit
  if (account.totalCost >= account.maxCostPerDay) {
    return 429; // Daily budget exceeded
  }

  // Check worker limit
  if (account.activeWorkers >= account.maxConcurrentWorkers) {
    return 429; // Too many workers
  }
}
```

**On worker completion:**
```typescript
if (worker.account.authType === 'api') {
  // Track cost
  account.totalCost += worker.costUsd;
  account.totalTasks += 1;

  // Optionally: alert if approaching limit
  if (account.totalCost >= account.maxCostPerDay * 0.9) {
    // Notify admins
  }
}
```

## Hybrid Strategy

Most organizations will use **both** authentication methods:

### Example: Acme Inc Setup

**Team Plan**: 10 seats × $30/mo = $300/mo (fixed)

**Accounts:**

| Account | Type | Auth | Limit | Use Case |
|---------|------|------|-------|----------|
| alice-laptop | user | OAuth | 1 session | Alice's personal dev |
| bob-coder | user | OAuth | 1 session | Bob in Coder workspace |
| charlie-laptop | user | OAuth | 1 session | Charlie working remotely |
| prod-worker-1 | service | API | $200/day | Production deployments |
| prod-worker-2 | service | API | $200/day | Background migrations |
| gh-ci-bot | action | API | $50/day | Test runs, CI/CD |

**Monthly costs:**
- **Fixed**: $300 (3 seats used)
- **Variable**: ~$300-600 (prod workers + CI)
- **Total**: ~$600-900/mo

**Benefits:**
- Devs use included seats (no marginal cost)
- Prod workers scale independently
- Clear cost attribution (dev vs prod)

## Migration Guide

### From API-Only to Hybrid

If you're currently using only API authentication:

1. **Identify user accounts**
   ```sql
   SELECT * FROM accounts WHERE type = 'user';
   ```

2. **Have users authenticate**
   ```bash
   claude auth
   export CLAUDE_CODE_OAUTH_TOKEN=$(cat ~/.config/claude/auth.json | jq -r .token)
   ```

3. **Update accounts**
   ```bash
   curl -X PATCH http://localhost:3000/api/accounts/acc-123 \
     -d '{
       "authType": "oauth",
       "oauthToken": "oauth_xxxxx",
       "maxConcurrentSessions": 1
     }'
   ```

4. **Restart agents** with new env var

### From OAuth-Only to Hybrid

If you need to add production workers:

1. **Get Anthropic API key** from console.anthropic.com

2. **Create service account**
   ```bash
   curl -X POST http://localhost:3000/api/accounts \
     -d '{
       "type": "service",
       "name": "Prod Worker",
       "authType": "api",
       "anthropicApiKey": "sk-ant-xxxxx",
       "maxCostPerDay": 500
     }'
   ```

3. **Deploy dedicated VM**
   ```bash
   export ANTHROPIC_API_KEY=sk-ant-xxxxx
   export BUILDD_API_KEY=buildd_svc_xxxxx
   ./buildd-agent --max-tasks=10
   ```

## FAQ

### Can one account use both OAuth and API?

**No.** Each account has a single `authType` - either `oauth` or `api`. Create separate accounts if you need both.

### What happens if OAuth token expires?

The agent will fail to authenticate with Claude. User must:
1. Run `claude auth` again
2. Update account with new `oauthToken`
3. Restart agent

### How is totalCost calculated for API accounts?

The Claude Agent SDK returns `total_cost_usd` in result messages. Server adds this to `account.totalCost`.

### Can I change authType after creation?

Not currently supported via API. You'd need to:
1. Create new account with desired authType
2. Grant workspace permissions
3. Migrate workers
4. Delete old account

Better: Create new account from the start.

### Do OAuth accounts still respect maxConcurrentWorkers?

**Yes.** Both OAuth and API accounts respect `maxConcurrentWorkers`. The difference is:
- **OAuth**: Also checks `maxConcurrentSessions`
- **API**: Also checks `maxCostPerDay`

### What if I exceed my Claude seat limit?

buildd will return `429 Too Many Requests` when claiming tasks. The agent will retry after 10 seconds. Either:
- Wait for existing sessions to complete
- Increase `maxConcurrentSessions` (if your plan allows)
- Add more seats to your Claude Team plan

### Can GitHub Actions use OAuth?

**Not recommended.** GitHub Actions are ephemeral runners that can't persist OAuth tokens. Use API authentication instead.

## Best Practices

### 1. Match Auth Type to Account Type

| Account Type | Recommended Auth | Reasoning |
|--------------|------------------|-----------|
| user | oauth | Use their included seat |
| service | api | Dedicated capacity, cost tracking |
| action | api | Ephemeral, can't persist OAuth |

### 2. Set Appropriate Limits

**OAuth accounts:**
- `maxConcurrentSessions = 1` for personal use
- `maxConcurrentSessions = 2-3` if plan allows
- `maxConcurrentWorkers = 3` to avoid overwhelming user

**API accounts:**
- `maxCostPerDay` based on budget ($50-500)
- `maxConcurrentWorkers` based on capacity (5-20)

### 3. Monitor Costs

For API accounts:
```sql
-- Daily cost by account
SELECT
  name,
  auth_type,
  total_cost::numeric,
  max_cost_per_day::numeric,
  (total_cost::numeric / max_cost_per_day::numeric * 100) as pct_used
FROM accounts
WHERE auth_type = 'api'
ORDER BY total_cost DESC;
```

### 4. Reset Daily Costs

Run this daily (e.g., via cron):
```sql
-- Reset API account costs at midnight
UPDATE accounts
SET total_cost = 0
WHERE auth_type = 'api';
```

Or implement rolling window in server code.

### 5. Alert on Limits

Add monitoring:
```typescript
// In worker completion handler
if (account.authType === 'api') {
  const pctUsed = account.totalCost / account.maxCostPerDay;

  if (pctUsed >= 0.8) {
    await sendAlert({
      severity: 'warning',
      message: `Account ${account.name} at ${pctUsed * 100}% of daily budget`
    });
  }

  if (pctUsed >= 0.95) {
    await sendAlert({
      severity: 'critical',
      message: `Account ${account.name} approaching daily limit`
    });
  }
}
```

## Summary

- **OAuth**: Seat-based, fixed cost, session-limited, best for team members
- **API**: Pay-per-token, variable cost, scale-friendly, best for production
- **Hybrid**: Use both - OAuth for devs, API for production/CI
- **Detection**: Agent auto-detects based on env vars
- **Tracking**: Server handles costs/sessions appropriately per auth type

Choose the right authentication method for each account type to optimize both cost and developer experience.
