# SDK Features

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 2. Sandbox Configuration

**Option**: `Options.sandbox`

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;    // Skip Bash permission if sandboxed
  allowUnsandboxedCommands?: boolean;    // Let model request unsandboxed execution via dangerouslyDisableSandbox
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
  excludedCommands?: string[];           // Commands that always bypass sandbox (e.g. ['docker'])
};

type NetworkSandboxSettings = {
  allowLocalBinding?: boolean;       // Allow binding to localhost
  allowUnixSockets?: string[];       // e.g. ['/var/run/docker.sock']
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
};

type SandboxIgnoreViolations = {
  file?: string[];     // File path patterns to ignore violations for
  network?: string[];  // Network patterns to ignore violations for
};
```

**Note**: Filesystem read/write and network *restrictions* are configured via permission rules, not sandbox settings. Sandbox settings control command execution sandboxing only.

---

## 3. 1M Context Beta

**Option**: `Options.betas`

```typescript
type SdkBeta = 'context-1m-2025-08-07';

options: {
  model: 'claude-sonnet-4-6',  // Sonnet 4.6+ only (4.5 being removed)
  betas: ['context-1m-2025-08-07'],
}
```

---

## 4. Plugin Support

**Option**: `Options.plugins`

```typescript
type SdkPluginConfig = {
  type: 'local';           // Only 'local' supported currently
  path: string;            // Absolute or relative path to plugin directory
};

options: {
  plugins: [
    { type: 'local', path: './my-plugin' },
  ]
}
```

Plugins provide custom commands, agents, skills, and hooks. Plugin info surfaced in `SDKSystemMessage.plugins` on init.

---

## 5. Structured Outputs

**Option**: `Options.outputFormat`

```typescript
type OutputFormat = {
  type: 'json_schema';
  schema: Record<string, unknown>;  // JSON Schema object
};

options: {
  outputFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: {
        result: { type: 'string' },
        confidence: { type: 'number' },
      },
      required: ['result', 'confidence'],
    }
  }
}

// Accessing:
if (msg.type === 'result' && msg.subtype === 'success') {
  const data = msg.structured_output;  // Parsed JSON matching schema
}
if (msg.type === 'result' && msg.subtype === 'error_max_structured_output_retries') {
  // Agent couldn't produce valid output after retries
}
```

---

## 6. Budget Limiting (`maxBudgetUsd`)

```typescript
options: { maxBudgetUsd: 5.00 }

if (msg.type === 'result') {
  console.log(`Total cost: $${msg.total_cost_usd}`);
  if (msg.subtype === 'error_max_budget_usd') {
    console.log('Budget exceeded');
  }
}
```

---

## 7. `stop_reason` in Results

Both `SDKResultSuccess` and `SDKResultError` include:

```typescript
stop_reason: string | null;  // e.g. "end_turn", "max_tokens", "stop_sequence", "tool_use"
```

---

## 8. Per-Model Usage Breakdown (`modelUsage`)

```typescript
type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
};

modelUsage: Record<string, ModelUsage>;  // Keyed by model identifier
usage: NonNullableUsage;                 // Aggregate usage
```

When the session uses multiple models (e.g., main model + subagent models), each gets its own `modelUsage` entry.

---

## 9. Debug / Logging Options

```typescript
options: {
  debug: true,                            // Enable verbose logging (--debug flag)
  debugFile: '/tmp/claude-debug.log',     // Write to file (implicitly enables debug)
  stderr: (data) => console.error(data),  // Capture stderr output
}
```

---

## 10. File Checkpointing

**Option**: `Options.enableFileCheckpointing`

```typescript
options: { enableFileCheckpointing: true }

// Rewind files to a specific user message:
await queryInstance.rewindFiles(userMessageUuid, { dryRun: false });

// Dry-run to preview:
const preview = await queryInstance.rewindFiles(userMessageUuid, { dryRun: true });
// RewindFilesResult: { canRewind, error?, filesChanged?, insertions?, deletions? }
```

The SDK emits `SDKFilesPersistedEvent` during streaming:
```typescript
type SDKFilesPersistedEvent = {
  type: 'system';
  subtype: 'files_persisted';
  files: { filename: string; file_id: string; }[];
  failed: { filename: string; error: string; }[];
  processed_at: string;
  uuid: UUID;
  session_id: string;
};
```

---

## 11. Hook Events Reference

### Official HookEvent Type (15 events)

```typescript
type HookEvent =
  | 'PreToolUse'          // Before tool execution (can block/modify)
  | 'PostToolUse'         // After tool execution
  | 'PostToolUseFailure'  // After tool execution failure
  | 'Notification'        // Agent status messages
  | 'UserPromptSubmit'    // User prompt submission
  | 'SessionStart'        // Session initialization
  | 'SessionEnd'          // Session termination
  | 'Stop'                // Agent execution stop
  | 'SubagentStart'       // Subagent initialization
  | 'SubagentStop'        // Subagent completion
  | 'PreCompact'          // Conversation compaction
  | 'PermissionRequest'   // Permission dialog
  | 'ConfigChange'        // Configuration file changes (v0.2.49+)
  | 'WorktreeCreate'      // After git worktree created (v2.1.50+)
  | 'WorktreeRemove';     // Before git worktree removed (v2.1.50+)
```

### Agent Teams Hooks (experimental)

These require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and type casting (`as any`):

```typescript
type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: 'TeammateIdle';
  teammate_name: string;
  team_name: string;
};

type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCompleted';
  task_id: string;
  task_subject: string;
  task_description?: string;
  teammate_name?: string;
  team_name?: string;
};
```

### All Hook Input Types

```typescript
type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
};

type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: unknown;
  error: string;
  is_interrupt?: boolean;
};

type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
};

type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  last_assistant_message?: string;  // v0.2.47+ — final response text from subagent
};

type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop';
  stop_hook_active: boolean;
  last_assistant_message?: string;  // v0.2.47+
};

type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];  // v0.2.49: now populated on safety check triggers
};

type NotificationHookInput = BaseHookInput & {
  hook_event_name: 'Notification';
  message: string;
  title?: string;
};

type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
};

type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd';
  reason: string;  // 'clear' | 'logout' | 'prompt_input_exit' | 'bypass_permissions_disabled' | 'other'
};
```

### Hook Callback Output

```typescript
// Async hooks: return immediately, run in background
type AsyncHookJSONOutput = { async: true; asyncTimeout?: number; };

// Sync hooks: block until complete
type SyncHookJSONOutput = {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  decision?: 'approve' | 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?:
    | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; updatedInput?: Record<string, unknown>; }
    | { hookEventName: 'UserPromptSubmit'; additionalContext?: string; }
    | { hookEventName: 'SessionStart'; additionalContext?: string; }
    | { hookEventName: 'PostToolUse'; additionalContext?: string; };
};
```

**Priority**: Deny > Ask > Allow > Default (ask). Any hook returning `deny` blocks the operation.

---

## 12. MCP Tool Annotations

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

const readTool = tool(
  'read_database', 'Read data from the database',
  { query: z.string() },
  async (args) => ({ content: [{ type: 'text', text: JSON.stringify(results) }] }),
  {
    annotations: {
      readOnly: true,
      destructive: false,
      openWorld: false,
    }
  }
);
```

---

## 13. `reconnectMcpServer()` / `toggleMcpServer()`

```typescript
const q = query({ prompt: "...", options: { mcpServers: { ... } } });

await q.reconnectMcpServer('my-server');
await q.toggleMcpServer('noisy-server', false);
await q.setMcpServers({ 'new-server': serverConfig });

const statuses = await q.mcpServerStatus();
// McpServerStatus[]: name, status ('connected'|'failed'|'needs-auth'|'pending'|'disabled'), tools[], error?
```

---

## 14. Agent Teams & Subagents

> Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var

### Manual Agent Definitions

```typescript
options: {
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
  allowedTools: ['Task', 'Read', ...],
  agents: {
    'security-auditor': {
      description: 'Audit code for vulnerabilities',
      prompt: 'You are a security expert...',
      tools: ['Read', 'Grep'],
      model: 'claude-opus-4-6',
    }
  }
}
```

### Skills as Subagents (Buildd Pattern)

**Implementation**: `apps/local-ui/src/workers.ts:936-947`

```typescript
const agents: Record<string, { description: string; prompt: string; tools: string[]; model: string }> = {};
for (const bundle of skillBundles) {
  agents[bundle.slug] = {
    description: bundle.description || bundle.name,
    prompt: bundle.content,
    tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
    model: 'inherit',
  };
}

options: {
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
  agents,
}
```

| Approach | Tool Delegation | When to Use |
|----------|----------------|-------------|
| **Skills as Agents** (`useSkillAgents: true`) | `Task` tool spawns named subagents | Agent decides when to delegate |
| **Skill Tool** (`useSkillAgents: false`) | `allowedTools: ['Skill(deploy)']` | Task requires specific skill execution |

**Stale Timeout**: Increase to 300s (from 120s) when using agent teams.

---

## 15. Agent Memory (CLI v2.1.33+)

```yaml
---
memory: project   # or 'user' or 'local'
---
```

Scopes: `user` (all projects), `project` (per-project in `.claude/`), `local` (per-machine). Auto-records/recalls during work when `settingSources` includes `'project'` or `'user'`.

---

## 16. Custom Session ID (SDK v0.2.33+)

```typescript
options: { sessionId: 'custom-uuid-here' }
```

Useful for correlating SDK sessions with external task/worker IDs.

---

## 17. Task(agent_type) Restriction (CLI v2.1.33+)

Agent frontmatter `tools` field restricts which sub-agent types can be spawned:

```yaml
---
tools:
  - Read
  - Write
  - Task(researcher)    # Only allow 'researcher' sub-agents
  - Task(test-runner)
---
```

---

## 18. PreToolUse Hook `updatedInput` (CLI v2.1.33+)

PreToolUse hooks can modify tool input (middleware-style):

```typescript
hooks: {
  PreToolUse: [{
    hooks: [async (input) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...input.tool_input, modified: true },
      }
    })]
  }]
}
```

---

## 19. Custom Permission Function (`canUseTool`)

```typescript
type CanUseTool = (
  toolName: string,
  input: ToolInput,
  options: { signal: AbortSignal; suggestions?: PermissionUpdate[]; }
) => Promise<PermissionResult>;

type PermissionResult =
  | { behavior: 'allow'; updatedInput: ToolInput; updatedPermissions?: PermissionUpdate[]; }
  | { behavior: 'deny'; message: string; interrupt?: boolean; };

// Usage:
options: {
  canUseTool: async (tool, input, { signal }) => {
    if (tool === 'Bash' && input.dangerouslyDisableSandbox) {
      return { behavior: 'deny', message: 'Unsandboxed commands not allowed' };
    }
    return { behavior: 'allow', updatedInput: input };
  },
}
```

---

## 20. Session Forking (`forkSession`)

```typescript
options: {
  resume: existingSessionId,
  forkSession: true,  // Creates new session ID; original preserved
}

options: {
  resume: existingSessionId,
  resumeSessionAt: 'specific-message-uuid',  // Rewind to specific point
}
```

---

## 21. In-Process MCP Servers (`createSdkMcpServer`)

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

const server = createSdkMcpServer({
  name: 'my-server',
  version: '1.0.0',
  tools: [
    tool('get_status', 'Get system status', { component: z.string() },
      async (args) => ({ content: [{ type: 'text', text: `Status: OK for ${args.component}` }] }),
      { annotations: { readOnly: true, destructive: false, openWorld: false } }
    ),
  ],
});

options: {
  mcpServers: { 'my-server': server },
  allowedTools: ['mcp__my-server__get_status'],
}
```

**Key advantage**: No subprocess startup cost, shared memory with host process.

### MCP Server Transport Types

```typescript
type McpServerConfig =
  | McpStdioServerConfig   // Subprocess with stdio transport
  | McpSSEServerConfig     // Server-Sent Events transport
  | McpHttpServerConfig    // HTTP Streamable transport
  | McpSdkServerConfigWithInstance; // In-process SDK server

type McpStdioServerConfig = { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string>; };
type McpSSEServerConfig  = { type: 'sse'; url: string; headers?: Record<string, string>; };
type McpHttpServerConfig = { type: 'http'; url: string; headers?: Record<string, string>; };
```

---

## 22. Compact Boundary Messages

```typescript
type SDKCompactBoundaryMessage = {
  type: 'system';
  subtype: 'compact_boundary';
  uuid: UUID;
  session_id: string;
  compact_metadata: { trigger: 'manual' | 'auto'; pre_tokens: number; };
};
```

`PreCompact` hook fires before compaction, allowing transcript archival.

---

## 23. SDKTaskStartedMessage (SDK v0.2.45+)

```typescript
type SDKTaskStartedMessage = {
  type: 'system'; subtype: 'task_started';
  task_id: string; tool_use_id?: string; description: string; task_type?: string;
  uuid: UUID; session_id: string;
};
```

Pair with `SDKTaskNotificationMessage` to track subagent start→completion lifecycle.

---

## 24. SDKRateLimitEvent (SDK v0.2.45+)

```typescript
type SDKRateLimitEvent = {
  type: 'system'; subtype: 'rate_limit';
  // Rate limit utilization, reset times, and overage info
};
```

Surface rate limit warnings to the dashboard or implement backoff strategies.

---

## 25. V2 Session `stream()` Fix (SDK v0.2.45)

Fixed `Session.stream()` returning prematurely when background subagents are still running. The SDK now holds back intermediate result messages until all tasks complete.

---

## 26. Memory Improvement (SDK v0.2.45)

Improved memory usage for shell commands with large output — RSS no longer grows unboundedly. Benefits long-running workers executing many bash commands.

---

## 27. `promptSuggestion()` Method (SDK v0.2.47)

```typescript
const queryInstance = query({ prompt, options });
const suggestions = await queryInstance.promptSuggestion();
```

Returns prompt suggestions for offering next-step recommendations to users.

---

## 28. `tool_use_id` on Task Notifications (SDK v0.2.47)

`SDKTaskNotificationMessage` now includes `tool_use_id` for correlating task completions with originating tool calls:

```typescript
if (msg.type === 'system' && msg.subtype === 'task_notification') {
  const { task_id, status, message, tool_use_id } = msg;
  // tool_use_id links back to the Task tool call that spawned this subagent
}
```

---

## 29. `last_assistant_message` on Stop/SubagentStop Hooks (SDK v0.2.47)

```typescript
hooks: {
  Stop: [{
    hooks: [async (input) => {
      const { last_assistant_message } = input as StopHookInput;
      // Use final message for summaries, logging, or worker status updates
      return {};
    }]
  }],
}
```

**Buildd use case**: Capture the worker's final summary for task completion without parsing transcripts.

---

## 30. Memory & Performance Improvements (CLI v2.1.47)

- **API stream buffer release**: Buffers released after use
- **Agent task message trimming**: Message history trimmed after subagent tasks complete
- **O(n²) progress update fix**: Progress updates no longer accumulate quadratically
- **Deferred SessionStart hook**: ~500ms faster startup
- **Concurrent agent fix**: API 400 errors ("thinking blocks cannot be modified") fixed

---

## 31. claude.ai MCP Connectors (CLI v2.1.46)

Support for using claude.ai MCP connectors within Claude Code. Workers can access MCP servers configured through the claude.ai web interface.

---

## 37. Background Agent Definitions (SDK v0.2.49)

Agent definitions now support `background: true`, making subagents always run as background tasks. This is useful for:

- Long-running monitoring agents that observe file changes or test results
- Parallel background work that doesn't block the main agent loop
- Audit/logging agents that run alongside the primary task

```typescript
agents: {
  'monitor': {
    description: 'Background monitoring agent',
    prompt: 'Monitor for issues...',
    tools: ['Read', 'Grep'],
    background: true,  // Always runs as background task
  }
}
```

The SDK emits `is_background: true` on `task_started` system messages for background subagents.

### Buildd Integration

- **Config**: `useBackgroundAgents` in workspace `gitConfig` (or per-task via `task.context.useBackgroundAgents`)
- **Resolution**: Task-level override > workspace-level setting
- **Implementation**: Both `worker-runner.ts` and `local-ui/workers.ts` pass `background: true` on skill-as-subagent definitions when enabled
- **Tracking**: `SubagentTask.isBackground` field tracks background status in local-ui, shown in milestone labels
