# API Patterns

## Authentication Flow

Every API route follows this pattern:

```ts
// 1. Try API key first
const apiKey = request.headers.get('authorization')?.replace('Bearer ', '');
const account = await authenticateApiKey(apiKey);

// 2. Fall back to session
const session = await auth();

// 3. Require one or the other
if (!account && !session?.user) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
```

API key format: `bld_` + 64 hex chars (256 bits entropy)

## Response Format

Consistent across all routes:

| Status | Meaning | Body |
|--------|---------|------|
| 200 | Success | Resource or array |
| 400 | Validation | `{ error: "field required" }` |
| 401 | No auth | `{ error: "Unauthorized" }` |
| 403 | Wrong owner | `{ error: "Forbidden" }` |
| 404 | Not found | `{ error: "X not found" }` |
| 429 | Rate limit | `{ error: "...", limit: N, current: N }` |

## Development Mode

All routes check `NODE_ENV === 'development'` and return mock data:

```ts
if (process.env.NODE_ENV === 'development') {
  return NextResponse.json([]);  // or mock object
}
```

No way to opt-out without env change. Inconsistent mock data shapes.

## Worker Protocol

### Claim Request
```ts
POST /api/workers/claim
{
  workspaceId?: string,      // Filter by workspace
  capabilities?: string[],   // Required capabilities
  maxTasks?: number          // Default: 3
}
```

### Claim Response
```ts
{
  workers: [{
    id: string,              // Worker UUID
    taskId: string,          // Task UUID
    branch: string,          // "buildd/abc12345-task-title"
    task: Task               // Full task object
  }]
}
```

### Status Update
```ts
PATCH /api/workers/[id]
{
  status?: WorkerStatusType,
  progress?: number,         // 0-100
  error?: string | null,
  costUsd?: number,
  turns?: number,
  localUiUrl?: string,
  currentAction?: string,
  milestones?: Array<{label, timestamp}>
}
```

### Ownership Enforcement
```ts
if (worker.accountId !== account.id) {
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
}
```

Workers strictly tied to claiming account.

## Pusher Events

Channel naming:
- `workspace-{id}` - workspace-level events
- `task-{id}` - task-specific events
- `worker-{id}` - worker-specific events

Event types:
- `task:created`, `task:claimed`, `task:completed`, `task:failed`
- `worker:started`, `worker:progress`, `worker:completed`, `worker:failed`
- `worker:command` - control messages (pause/resume/abort)

Pusher is optional - silent no-op if credentials missing.
