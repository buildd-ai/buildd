## Agent SDK Usage (@anthropic-ai/claude-agent-sdk)


**Version documented**: 0.2.44 (all packages aligned)

### Monorepo SDK Versions

| Package | Version | Notes |
|---------|---------|-------|
| `apps/local-ui` | `>=0.2.37` | Full v0.2.x features |
| `packages/core` | `^0.1.19` | Legacy, needs upgrade for v0.2.x features |
| `apps/agent` | `^0.1.19` | Legacy, needs upgrade for v0.2.x features |

---

## API Overview

The SDK exposes two main APIs:

| API | Use Case | Options Support |
|-----|----------|-----------------|
| `query()` (V1) | Task orchestration, workers, full-featured | **All options** — cwd, settingSources, systemPrompt, mcpServers, sandbox, plugins, betas, agents, hooks, etc. |
| V2 Session API | Interactive sessions, multi-turn chat | **Limited** — model, env, allowedTools, disallowedTools, permissionMode, hooks, canUseTool (no cwd, settingSources, systemPrompt, mcpServers, sandbox, plugins, etc.) |

**Recommendation**: Use `query()` for Buildd workers. Use V2 only for simple interactive sessions.

---

## Local-UI Implementation

**Location**: `apps/local-ui/src/workers.ts`

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.includes('CLAUDE_CODE_OAUTH_TOKEN')
  )
);
cleanEnv.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1';

const queryInstance = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    model: 'claude-sonnet-4-5-20250929',
    abortController,
    env: cleanEnv,
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
    agents: {
      'deploy': {
        description: 'Handles deployment workflows',
        prompt: '<skill content>',
        tools: ['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write'],
        model: 'inherit',
      }
    },
  },
});

for await (const msg of queryInstance) {
  handleMessage(msg);
  if (msg.type === 'result') break;
}
```

Key features used:
- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — Enables agent teams & Task delegation
- `settingSources: ['project']` — Auto-loads workspace CLAUDE.md
- `cwd` — Sets working directory for file operations
- `env` — Filtered env to avoid expired OAuth tokens
- `abortController` — Enables task cancellation
- `permissionMode: 'acceptEdits'` — Autonomous execution without prompts
- `agents` — Skills-as-subagents for Task tool delegation
- Break on `result` message to avoid process exit errors

---

## Core Integration Pattern

Standard setup for spawning workers that respect project context.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task']
  }
});
```

---

## 1. V2 Session API (send/receive/done pattern)

> Status: `@alpha`, marked `UNSTABLE`. Significantly improved since v0.1.77.

### `SDKSession` interface

```typescript
interface SDKSession {
  readonly sessionId: string;  // Available after first message (or immediately for resumed)
  send(message: string | SDKUserMessage): Promise<void>;
  stream(): AsyncGenerator<SDKMessage, void>;
  close(): void;
  [Symbol.asyncDispose](): Promise<void>;
}
```

### V2 Functions

```typescript
// Create a new persistent session
function unstable_v2_createSession(options: SDKSessionOptions): SDKSession;

// One-shot convenience (returns the final result)
function unstable_v2_prompt(message: string, options: SDKSessionOptions): Promise<SDKResultMessage>;

// Resume an existing session by ID
function unstable_v2_resumeSession(sessionId: string, options: SDKSessionOptions): SDKSession;
```

### Usage pattern

```typescript
await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929',
  permissionMode: 'acceptEdits',
  allowedTools: ['Read', 'Write', 'Bash'],
});

await session.send("What files are here?");
for await (const msg of session.stream()) {
  if (msg.type === 'result') break;
}
// session.close() called automatically via Symbol.asyncDispose
```

### SDKSessionOptions (v0.2.44)

The V2 session now supports more options than v0.1.77:

```typescript
type SDKSessionOptions = {
  model: string;
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun';
  executableArgs?: string[];
  env?: { [envVar: string]: string | undefined };
  // NEW in v0.2.x:
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  permissionMode?: PermissionMode;  // 'default' | 'acceptEdits' | 'plan' | 'dontAsk'
};
```

### V2 Still Does NOT Support

These `Options` (V1) fields remain unavailable in V2: `cwd`, `settingSources`, `systemPrompt`, `mcpServers`, `sandbox`, `plugins`, `betas`, `maxBudgetUsd`, `maxTurns`, `outputFormat`, `agents`, `enableFileCheckpointing`, `debug`, `debugFile`, `thinking`, `effort`, `additionalDirectories`, `fallbackModel`, `resume`, `continue`, `persistSession`.

**For orchestration with project context, use `query()`.**

---

## 2. Sandbox Configuration

**Option**: `Options.sandbox`

```typescript
type SandboxSettings = {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;    // Skip Bash permission if sandboxed
  allowUnsandboxedCommands?: boolean;
  network?: SandboxNetworkConfig;
  ignoreViolations?: Record<string, string[]>;  // tool name → violation strings to ignore
  enableWeakerNestedSandbox?: boolean;
  excludedCommands?: string[];
  ripgrep?: { command: string; args?: string[] };  // Custom rg binary for sandbox
};

type SandboxNetworkConfig = {
  allowedDomains?: string[];
  allowManagedDomainsOnly?: boolean;
  allowUnixSockets?: string[];      // e.g. ['/var/run/docker.sock']
  allowAllUnixSockets?: boolean;
  allowLocalBinding?: boolean;       // Allow binding to localhost
  httpProxyPort?: number;
  socksProxyPort?: number;
};
```

### Usage

```typescript
options: {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: ['docker'],
    network: {
      allowLocalBinding: true,
      allowedDomains: ['api.example.com'],
      httpProxyPort: 8080,
    },
    ignoreViolations: {
      Bash: ['network_access_violation'],
    },
  }
}
```

**Note**: Filesystem and network *restrictions* are configured via permission rules, not sandbox settings. Sandbox settings control sandbox *behavior*.

---

## 3. 1M Context Beta

**Option**: `Options.betas`

```typescript
type SdkBeta = 'context-1m-2025-08-07';

// Usage:
options: {
  model: 'claude-sonnet-4-5-20250929',  // Sonnet 4/4.5 only
  betas: ['context-1m-2025-08-07'],
}
```

Enables 1M token context window. The beta string is surfaced in `SDKSystemMessage.betas` on init.

---

## 4. Plugin Support

**Option**: `Options.plugins`

```typescript
type SdkPluginConfig = {
  type: 'local';           // Only 'local' supported currently
  path: string;            // Absolute or relative path to plugin directory
};

// Usage:
options: {
  plugins: [
    { type: 'local', path: './my-plugin' },
    { type: 'local', path: '/absolute/path/to/plugin' },
  ]
}
```

Plugins provide custom commands, agents, skills, and hooks. Plugin info is surfaced in `SDKSystemMessage.plugins` on init:
```typescript
plugins: { name: string; path: string; }[];
```

---

## 5. Structured Outputs

**Option**: `Options.outputFormat`

```typescript
type OutputFormat = {
  type: 'json_schema';
  schema: Record<string, unknown>;  // JSON Schema object
};

// Usage:
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
```

### Accessing structured output

```typescript
if (msg.type === 'result' && msg.subtype === 'success') {
  const data = msg.structured_output;  // Parsed JSON matching schema
}

// Schema validation failure:
if (msg.type === 'result' && msg.subtype === 'error_max_structured_output_retries') {
  // Agent couldn't produce valid output after retries
}
```

---

## 6. Budget Limiting (`maxBudgetUsd`)

**Option**: `Options.maxBudgetUsd`

```typescript
options: {
  maxBudgetUsd: 5.00,  // Stop if cost exceeds $5
}

// Result:
if (msg.type === 'result') {
  console.log(`Total cost: $${msg.total_cost_usd}`);
  if (msg.subtype === 'error_max_budget_usd') {
    console.log('Budget exceeded');
  }
}
```

Both `SDKResultSuccess` and `SDKResultError` include `total_cost_usd: number`.

---

## 7. `stop_reason` in Results

Both `SDKResultSuccess` and `SDKResultError` now include:

```typescript
stop_reason: string | null;  // e.g. "end_turn", "max_tokens", "stop_sequence", "tool_use"
```

---

## 8. Per-Model Usage Breakdown (`modelUsage`)

Both result types include a per-model breakdown:

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

// In results:
modelUsage: Record<string, ModelUsage>;  // Keyed by model identifier
usage: NonNullableUsage;                 // Aggregate usage
```

When the session uses multiple models (e.g., main model + subagent models), each gets its own `modelUsage` entry.

---

## 9. Debug / Logging Options

**Options**: `Options.debug`, `Options.debugFile`, `Options.stderr`

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
// Enable:
options: {
  enableFileCheckpointing: true,
}

// Rewind files to a specific user message:
await queryInstance.rewindFiles(userMessageUuid, { dryRun: false });

// Dry-run to preview:
const preview = await queryInstance.rewindFiles(userMessageUuid, { dryRun: true });
// RewindFilesResult: { canRewind, error?, filesChanged?, insertions?, deletions? }
```

### Files Persisted Event

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

## 11. TeammateIdle / TaskCompleted Hooks

Two new hook events for agent teams coordination:

```typescript
// All 15 hook events:
const HOOK_EVENTS = [
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification',
  'UserPromptSubmit', 'SessionStart', 'SessionEnd', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'PermissionRequest',
  'Setup', 'TeammateIdle', 'TaskCompleted',  // <-- new
] as const;

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

type BaseHookInput = {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
};
```

### Usage

```typescript
options: {
  hooks: {
    TeammateIdle: [{
      hooks: [async (input) => {
        const { teammate_name, team_name } = input as TeammateIdleHookInput;
        console.log(`${teammate_name} idle in ${team_name}`);
        return {};
      }]
    }],
    TaskCompleted: [{
      hooks: [async (input) => {
        const { task_id, task_subject } = input as TaskCompletedHookInput;
        console.log(`Task ${task_id} "${task_subject}" done`);
        return {};
      }]
    }],
  }
}
```

---

## 12. MCP Tool Annotations

Tools defined via `createSdkMcpServer` now support MCP tool annotations:

```typescript
import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod/v4';

const readTool = tool(
  'read_database',
  'Read data from the database',
  { query: z.string() },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(results) }]
  }),
  {
    annotations: {
      readOnly: true,       // Tool does not modify state
      destructive: false,   // Tool is not destructive
      openWorld: false,     // Tool does not access external resources
    }
  }
);
```

Annotations are also visible in `McpServerStatus.tools[].annotations`.

---

## 13. `reconnectMcpServer()` / `toggleMcpServer()`

Dynamic MCP server management on a running query:

```typescript
const q = query({ prompt: "...", options: { mcpServers: { ... } } });

// Reconnect a failed server:
await q.reconnectMcpServer('my-server');

// Disable/enable a server:
await q.toggleMcpServer('noisy-server', false);
await q.toggleMcpServer('noisy-server', true);

// Replace all dynamic servers:
await q.setMcpServers({ 'new-server': serverConfig });

// Check status:
const statuses = await q.mcpServerStatus();
// McpServerStatus[]: name, status ('connected'|'failed'|'needs-auth'|'pending'|'disabled'), tools[], error?
```

---

## 14. Agent Teams & Subagents

> Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` env var (as of SDK v0.2.44)

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
      model: 'claude-3-opus-20240229',
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

**Stale Timeout**: When using agent teams, increase stale worker timeout to 300s (from 120s) to account for subagent coordination overhead.

---

## Additional Options Reference

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
| `interrupt()` | Stop current execution |
| `setPermissionMode(mode)` | Change permission mode mid-session |
| `setModel(model?)` | Switch model mid-session |
| `initializationResult()` | Get full init response |
| `supportedCommands()` | List available skills |
| `supportedModels()` | List available models |
| `mcpServerStatus()` | Get MCP server statuses |
| `accountInfo()` | Get account info |
| `rewindFiles(messageId, opts?)` | Rewind file changes |
| `reconnectMcpServer(name)` | Reconnect MCP server |
| `toggleMcpServer(name, enabled)` | Enable/disable MCP server |
| `setMcpServers(servers)` | Replace dynamic MCP servers |
| `streamInput(stream)` | Stream user messages |
| `stopTask(taskId)` | Stop a background task |
| `close()` | Terminate the query |

### SDKResultMessage

```typescript
type SDKResultSuccess = {
  type: 'result';
  subtype: 'success';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: NonNullableUsage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
  structured_output?: unknown;
  uuid: UUID;
  session_id: string;
};

type SDKResultError = {
  type: 'result';
  subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries';
  // Same fields as success, plus:
  errors: string[];
};
```

### SDKMessage Union (16 types)

`SDKAssistantMessage`, `SDKUserMessage`, `SDKUserMessageReplay`, `SDKResultMessage`, `SDKSystemMessage`, `SDKPartialAssistantMessage`, `SDKCompactBoundaryMessage`, `SDKStatusMessage`, `SDKHookStartedMessage`, `SDKHookProgressMessage`, `SDKHookResponseMessage`, `SDKToolProgressMessage`, `SDKAuthStatusMessage`, `SDKTaskNotificationMessage`, `SDKFilesPersistedEvent`, `SDKToolUseSummaryMessage`

### Available Tools Reference

* **File Ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep`
* **Shell**: `Bash`, `BashOutput`, `KillBash`
* **Interaction** (user-facing, filtered from subagents): `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `TaskOutput`
* **Delegation**: `Task`
* **Web**: `WebSearch`, `WebFetch`

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

### SDKUserMessage Format

```typescript
interface SDKUserMessage {
  type: 'user';
  session_id: string;
  message: { role: 'user'; content: ContentBlock[] };
  parent_tool_use_id: string | null;  // Links response to a pending tool call
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

Without correct `parent_tool_use_id`, the CLI treats the response as a new user message rather than a tool result. The same pattern applies to `ExitPlanMode`.

---

## Known Issues

### CLAUDE_CODE_OAUTH_TOKEN env var

If `CLAUDE_CODE_OAUTH_TOKEN` is set with an expired/invalid token, it overrides valid credentials causing 401 errors. Local-UI filters this out automatically.

```bash
unset CLAUDE_CODE_OAUTH_TOKEN
```

---

## Integration Test

**Location**: `apps/local-ui/src/test-query-integration.ts`
**Run**: `bun run test:integration` (from `apps/local-ui`)

Tests that `query()` with `settingSources: ['project']` correctly loads CLAUDE.md by checking for a unique marker.
