# Advanced Reference

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## Additional Options Reference

| Option | Type | Description |
|--------|------|-------------|
| `allowDangerouslySkipPermissions` | `boolean` | Required when using `permissionMode: 'bypassPermissions'` |
| `extraArgs` | `Record<string, string \| null>` | Additional CLI arguments |
| `fallbackModel` | `string` | Model to use if primary fails |
| `includePartialMessages` | `boolean` | Include `SDKPartialAssistantMessage` streaming events |
| `maxThinkingTokens` | `number` | Maximum tokens for thinking process |
| `permissionPromptToolName` | `string` | MCP tool name for permission prompts |
| `strictMcpConfig` | `boolean` | Enforce strict MCP validation |
| `tools` | `string[] \| { type: 'preset'; preset: 'claude_code' }` | Tool configuration (distinct from `allowedTools`) |

### Thinking / Effort Controls

```typescript
options: {
  thinking: { type: 'adaptive' }
           | { type: 'enabled', budgetTokens: number }
           | { type: 'disabled' },
  effort: 'low' | 'medium' | 'high' | 'max',
}
```

### All Query Control Methods

| Method | Description |
|--------|-------------|
| `interrupt()` | Stop current execution (streaming input mode) |
| `setPermissionMode(mode)` | Change permission mode mid-session |
| `setModel(model?)` | Switch model mid-session |
| `setMaxThinkingTokens(n)` | Change max thinking tokens mid-session |
| `supportedCommands()` | List available slash commands |
| `supportedModels()` | List available models with display info |
| `mcpServerStatus()` | Get MCP server statuses |
| `accountInfo()` | Get account info |
| `rewindFiles(messageId, opts?)` | Rewind file changes (requires `enableFileCheckpointing`) |
| `reconnectMcpServer(name)` | Reconnect MCP server |
| `toggleMcpServer(name, enabled)` | Enable/disable MCP server |
| `setMcpServers(servers)` | Replace dynamic MCP servers |
| `streamInput(stream)` | Stream user messages |
| `stopTask(taskId)` | Stop a background task |
| `promptSuggestion()` | Request prompt suggestions (v0.2.47+) |
| `listSessions()` | List past sessions with light metadata (v0.2.53+) |
| `close()` | Terminate the query |

### SDKResultMessage

```typescript
type SDKResultSuccess = {
  type: 'result'; subtype: 'success';
  duration_ms: number; duration_api_ms: number;
  is_error: boolean; num_turns: number; result: string;
  stop_reason: string | null; total_cost_usd: number;
  usage: NonNullableUsage; modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  uuid: UUID; session_id: string;
};

type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  errors: string[];
  // Same fields as success
};
```

### SDKMessage Union

```typescript
type SDKMessage =
  | SDKAssistantMessage          // Assistant response with content blocks
  | SDKUserMessage               // User input message
  | SDKUserMessageReplay         // Replayed user message (with required UUID)
  | SDKResultMessage             // Final result (success or error subtypes)
  | SDKSystemMessage             // System init message (subtype: 'init')
  | SDKPartialAssistantMessage   // Streaming partial (requires includePartialMessages)
  | SDKCompactBoundaryMessage;   // Conversation compaction boundary
```

Additional streaming types: `SDKStatusMessage`, `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage`, `SDKToolProgressMessage`, `SDKAuthStatusMessage`, `SDKTaskNotificationMessage`, `SDKTaskStartedMessage`, `SDKTaskProgressEvent` (v0.2.51+), `SDKRateLimitEvent`, `SDKFilesPersistedEvent`, `SDKToolUseSummaryMessage`

### Available Tools Reference

* **File Ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit`
* **Shell**: `Bash`, `BashOutput`, `KillBash`
* **Interaction**: `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `TodoWrite`
* **Delegation**: `Task`, `TaskOutput`
* **Web**: `WebSearch`, `WebFetch`
* **MCP**: `ListMcpResources`, `ReadMcpResource`

---

## Observability via Hooks

Intercept actions for logging to Buildd task logs or dashboards.

```typescript
options: {
  hooks: {
    PreToolUse: [{ matcher: null, hooks: [logHook] }],     // Match all tools
    PostToolUse: [{ matcher: 'Bash', hooks: [logBash] }],  // Match specific tool
  }
}
```

---

## MCP Server Integration

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod/v4";

const builddServer = createSdkMcpServer({
  name: "buildd-core",
  version: "1.0.0",
  tools: [
    tool("report_progress", "Report task status", { status: z.string() },
      async (args) => ({ content: [{ type: 'text', text: 'OK' }] }),
      { annotations: { readOnly: false } }
    )
  ]
});

options: {
  mcpServers: { "buildd": builddServer },
  allowedTools: ["mcp__buildd__report_progress"]  // Namespace: mcp__{server}__{tool}
}
```

---

## Multi-Turn Conversations & User Input Tools

### How `streamInput` Works

```typescript
const inputStream = new MessageStream();
const queryInstance = query({ prompt, options });
queryInstance.streamInput(inputStream);

for await (const msg of queryInstance) {
  handleMessage(msg);
  if (msg.type === 'result') break;
}
```

### AskUserQuestion in SDK Mode

**Problem**: When the CLI subprocess encounters `AskUserQuestion`, in non-interactive (no TTY) mode it auto-resolves without waiting for user input.

**Fix** (implemented in local-ui): Set `parent_tool_use_id` and `session_id` correctly:

```typescript
// Capture the tool_use block ID
if (toolName === 'AskUserQuestion') {
  worker.waitingFor = { ..., toolUseId: block.id };
}

// Link response to the tool call
session.inputStream.enqueue(buildUserMessage(answer, {
  parentToolUseId: worker.waitingFor?.toolUseId,
  sessionId: worker.sessionId,  // From SDK's system/init message
}));
```

Without correct `parent_tool_use_id`, the CLI treats the response as a new user message rather than a tool result. Same pattern applies to `ExitPlanMode`.

---

## Known Issues

### CLAUDE_CODE_OAUTH_TOKEN env var

If `CLAUDE_CODE_OAUTH_TOKEN` is set with an expired/invalid token, it overrides valid credentials causing 401 errors. Local-UI filters this out automatically:

```bash
unset CLAUDE_CODE_OAUTH_TOKEN
```

---

## Integration Test

**Location**: `apps/local-ui/src/test-query-integration.ts`
**Run**: `bun run test:integration` (from `apps/local-ui`)

Tests that `query()` with `settingSources: ['project']` correctly loads CLAUDE.md by checking for a unique marker.

---

## Prompt Suggestions (local-ui implementation)

The CLI's `promptSuggestion` feature is internal to the terminal UI and **not exposed** on the programmatic `Query` interface (as of v0.2.45). Local-UI implements its own:

- **Location**: `apps/local-ui/src/workers.ts` — `generatePromptSuggestions()`
- **Trigger**: Called after successful task completion
- **Approach**: Heuristic-based suggestions from worker context (commits, tool calls, task metadata) — no extra LLM call
- **Storage**: `worker.promptSuggestions: string[]` — persisted via worker-store, exposed via `/api/workers` and SSE events
- **UI**: Rendered as clickable chips in the worker detail view
