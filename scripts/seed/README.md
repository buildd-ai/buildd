# Seed Scripts

This directory contains scripts for seeding test data into the database.

## Usage

All seed scripts require a `BUILDD_API_KEY` environment variable to be set.

```bash
# Set your API key (get one from the dashboard)
export BUILDD_API_KEY=your_api_key

# Optional: Use real user auth in dev mode
export DEV_USER_EMAIL=your@email.com
```

### Available Seeds

#### `waiting-input`
Creates a task with a worker in the `waiting_input` state.

```bash
bun run seed:waiting-input
```

This creates:
- A task titled "[SEED] Waiting input test"
- A worker assigned to the task
- Worker status set to `waiting_input` with a question prompt and options

#### `knowledge-consolidation`
Opts a workspace into the weekly knowledge-consolidation agent task (merge
near-duplicate knowledge, archive decayed zero-hit chunks, emit a report
artifact — see `docs/design/workspace-knowledge-management.md` §5). Per-workspace
and opt-in by design; idempotent per workspace. Not tracked by `seed:reset` —
remove via the dashboard or the `delete_schedule` MCP action.

```bash
BUILDD_API_KEY=your_key WORKSPACE_ID=<workspace-uuid> bun run seed:knowledge-consolidation
```

#### `knowledge-digest`
Opts a workspace into the weekly workspace-digest agent task (synthesise the last
7 days of merged PRs, completed tasks, and new memories into a concise digest,
saved as a `type=summary` artifact that is auto-indexed — see
`docs/design/workspace-knowledge-management.md` §6.2). Per-workspace and opt-in by
design; idempotent per workspace. Not tracked by `seed:reset` — remove via the
dashboard or the `delete_schedule` MCP action.

```bash
BUILDD_API_KEY=your_key WORKSPACE_ID=<workspace-uuid> bun run seed:knowledge-digest
```

#### `reset`
Cleans up the most recently seeded data.

```bash
bun run seed:reset
```

## Adding New Seeds

1. Create a new file in `scripts/seed/` (e.g., `my-seed.ts`)
2. Add a script entry to `package.json`:
   ```json
   "seed:my-seed": "bun run scripts/seed/my-seed.ts"
   ```
3. Save seed metadata to `.last-seed.json` so the reset script can clean up

## Notes

- Seed data is stored in `.last-seed.json` for cleanup tracking
- The `.last-seed.json` file is gitignored
- Seeds use the API, so they work against both local and production environments
