# Testing Guide

This document covers the testability features built into Buildd for local development and E2E testing.

## Dev Mode Authentication

### Problem Solved
In `development` mode, the auth system returns a mock "Dev User" by default. This user doesn't own any real data in the database, making it impossible to test features that require real workspace/task data.

### Solution: DEV_USER_EMAIL
Set the `DEV_USER_EMAIL` environment variable to authenticate as a real user from the database:

```bash
# One-time run
DEV_USER_EMAIL=your@email.com bun dev

# Or add to .env.local (not recommended - easy to forget)
DEV_USER_EMAIL=your@email.com
```

**How it works**: `lib/auth-helpers.ts` checks for this env var in dev mode and queries the database for that user before falling back to the mock user.

## Seed Scripts

Located in `scripts/seed/`, these scripts create reproducible test data.

### Available Seeds

| Command | Description |
|---------|-------------|
| `bun run seed:waiting-input` | Creates a task with a worker in `waiting_input` state |
| `bun run seed:reset` | Cleans up the most recently seeded data |

### Requirements
- `BUILDD_API_KEY` environment variable must be set
- Optionally set `BUILDD_SERVER` to target a different environment (default: `https://app.buildd.dev`)

### Example
```bash
export BUILDD_API_KEY=bld_your_key_here
bun run seed:waiting-input

# View the seeded task
# → Task ID: abc123
# → View at: https://app.buildd.dev/app/tasks/abc123

# When done testing
bun run seed:reset
```

### Adding New Seeds
1. Create `scripts/seed/my-seed.ts`
2. Add `"seed:my-seed": "bun run scripts/seed/my-seed.ts"` to `package.json`
3. Save seed metadata to `.last-seed.json` for cleanup support

## UI Fixtures

### Purpose
Test UI components in isolation without database dependencies. Useful for:
- Visual regression testing
- Rapid UI iteration
- Demonstrating component states

### Usage
Navigate to: `http://localhost:3001/app/dev/fixtures?state=<state>`

Available states:
- `waiting-input` - Worker waiting for user input
- `running` - Worker actively executing
- `completed` - Worker finished successfully
- `failed` - Worker encountered an error

### How It Works
The fixtures page (`apps/web/src/app/app/dev/fixtures/page.tsx`) renders the `RealTimeWorkerView` component with hardcoded mock data for each state.

## data-testid Conventions

UI components have `data-testid` attributes for reliable E2E test selectors.

### Available Test IDs

| Test ID | Component | Location |
|---------|-----------|----------|
| `task-header-status` | Status badge | Task detail page header |
| `sidebar-task-item` | Task link | Sidebar navigation |
| `sidebar-task-question` | Question text | Sidebar (when waiting_input) |
| `worker-needs-input-banner` | Banner container | Active worker section |
| `worker-needs-input-label` | "Needs input" label | Banner |
| `worker-needs-input-prompt` | Question text | Banner |
| `worker-needs-input-options` | Options container | Banner |

### Data Attributes
Some elements include additional data attributes:
- `data-status` - Current status (e.g., `waiting_input`, `running`)
- `data-task-id` - Task UUID

### Example Playwright/Cypress Usage
```javascript
// Find tasks in waiting_input state
const waitingTasks = page.locator('[data-testid="sidebar-task-item"][data-status="waiting_input"]');

// Verify the needs-input banner is visible
await expect(page.locator('[data-testid="worker-needs-input-banner"]')).toBeVisible();

// Check the question text
const prompt = await page.locator('[data-testid="worker-needs-input-prompt"]').textContent();
expect(prompt).toContain('authentication method');
```

## Best Practices

1. **Always use data-testid for E2E tests** - Don't rely on CSS classes (they change with styling)
2. **Clean up seeded data** - Run `seed:reset` after testing to avoid polluting the database
3. **Use fixtures for UI development** - Faster iteration than creating real data
4. **Document new test IDs** - Add them to this file when creating new data-testid attributes
