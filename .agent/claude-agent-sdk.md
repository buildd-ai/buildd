## Agent SDK Usage (@anthropic-ai/claude-agent-sdk)

> **Version investigated**: 0.1.77 / 0.2.37

---

## Local-UI Implementation

**Location**: `apps/local-ui/src/workers.ts`

Uses `query()` API for task execution:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// Filter out problematic env vars (expired OAuth tokens)
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.includes('CLAUDE_CODE_OAUTH_TOKEN')
  )
);

const queryInstance = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    model: 'claude-sonnet-4-5-20250929',
    abortController,
    env: cleanEnv,
    settingSources: ['project'],  // Loads CLAUDE.md
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
  },
});

// Stream responses, break on result
for await (const msg of queryInstance) {
  handleMessage(msg);
  if (msg.type === 'result') break;
}
```

Key features used:
- `settingSources: ['project']` - Auto-loads workspace CLAUDE.md
- `cwd` - Sets working directory for file operations
- `env` - Filtered env to avoid expired OAuth tokens
- `abortController` - Enables task cancellation
- `permissionMode: 'acceptEdits'` - Autonomous execution without prompts
- Break on `result` message to avoid process exit errors

---

## ⚠️ CRITICAL: V2 Session API Limitations

**The `unstable_v2_createSession` API does NOT support most orchestration options.**

Investigation of `sdk.mjs` (2025-02) revealed that `SessionImpl` hardcodes defaults and ignores user-provided options:

```javascript
// From sdk.mjs - SessionImpl constructor
const transport = new ProcessTransport({
  settingSources: [],           // HARDCODED - user option IGNORED
  mcpServers: {},               // HARDCODED - user option IGNORED
  permissionMode: "default",    // HARDCODED - user option IGNORED
  // cwd, systemPrompt, hooks, etc. are NOT passed through
});
```

### API Comparison

| Option | `query()` | `unstable_v2_createSession()` |
|--------|-----------|------------------------------|
| `cwd` | ✅ Passed to CLI | ❌ Ignored |
| `settingSources` | ✅ `--setting-sources` flag | ❌ Hardcoded `[]` |
| `systemPrompt` | ✅ Handled (string or preset) | ❌ Ignored |
| `mcpServers` | ✅ `--mcp-config` flag | ❌ Hardcoded `{}` |
| `permissionMode` | ✅ Passed | ❌ Hardcoded `"default"` |
| `hooks` | ✅ Supported | ❌ Hardcoded `false` |
| `allowedTools` | ✅ Passed | ❌ Hardcoded `[]` |

### When to Use Each API

| Use Case | Recommended API |
|----------|-----------------|
| Simple interactive chat | `unstable_v2_createSession` |
| Task orchestration with project context | `query()` |
| Multi-workspace worker execution | `query()` |
| Sessions needing CLAUDE.md | `query()` with `settingSources: ['project']` |

### Key Insight: CLAUDE.md Loading

To auto-load a project's CLAUDE.md, you **must** use `query()` with:
```typescript
settingSources: ['project']  // Loads .claude/settings.json AND CLAUDE.md
```

The V2 session API cannot load CLAUDE.md because `settingSources` is hardcoded to `[]`.

---

### Core Integration Pattern
Standard setup for spawning workers that respect project context.

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    settingSources: ['project'], // CRITICAL: Loads target repo's CLAUDE.md & settings
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits', // Use 'bypassPermissions' for CI/Autonomous runs
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task']
  }
});

```

### 1. Session Management (V2)

> ⚠️ **Limited options support** - See "V2 Session API Limitations" above.
> Only use for simple interactive sessions. For orchestration, use `query()`.

The V2 API only supports these options (as of 0.1.77):
- `model` - Model to use
- `pathToClaudeCodeExecutable` - Custom CLI path
- `executable` - `'node'` or `'bun'`
- `executableArgs` - Args for runtime
- `env` - Environment variables
- `resume` - Session ID to resume

```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';

// Create new session (simple interactive use only)
await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929'
});

// Resume existing session
await using resumedSession = unstable_v2_resumeSession(sessionId, {
  model: 'claude-sonnet-4-5-20250929'
});

// For orchestration with full options, use query() instead:
// query({ prompt, options: { cwd, settingSources, systemPrompt, ... } })

```

### 2. MCP Server Integration

Use `createSdkMcpServer` to expose internal `buildd` state or tools to agents.

```typescript
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

const builddServer = createSdkMcpServer({
  name: "buildd-core",
  version: "1.0.0",
  tools: [
    tool("report_progress", "Report task status", { status: z.string() }, async (args) => { /*...*/ })
  ]
});

// Usage in query options
options: {
  mcpServers: { "buildd": builddServer },
  allowedTools: ["mcp__buildd__report_progress"] // Namespace: mcp__{server}__{tool}
}

```

### 3. Subagents & Delegation

Use subagents for specialized tasks to keep context clean.

```typescript
options: {
  allowedTools: ['Task', 'Read', ...], // 'Task' tool is required for delegation
  agents: {
    'security-auditor': {
      description: 'Audit code for vulnerabilities',
      prompt: 'You are a security expert. Focus on auth patterns...',
      tools: ['Read', 'Grep'], // Restricted toolset
      model: 'claude-3-opus-20240229' // Model override for high-intelligence tasks
    }
  }
}

```

### 4. Observability via Hooks

Intercept actions for logging to `buildd` task logs or dashboards.

```typescript
const logHook = async (input, toolUseId) => {
  // Input types: PreToolUseHookInput | PostToolUseHookInput
  if (input.hook_event_name === 'PreToolUse') {
    console.log(`[${toolUseId}] Agent executing: ${input.tool_name}`);
  }
  return {};
};

options: {
  hooks: {
    PreToolUse: [{ matcher: null, hooks: [logHook] }], // Match all tools
    PostToolUse: [{ matcher: 'Bash', hooks: [logBashOutput] }] // Match specific tools
  }
}

```

### 5. Sandbox Configuration

Enforce security boundaries, especially for untrusted code execution.

```typescript
options: {
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true, // Skip approval if sandbox is active
    network: {
      allowLocalBinding: true, // Allow binding to localhost (e.g. dev servers)
      // allowUnixSockets: ['/var/run/docker.sock'] // Careful with this
    }
  }
}

```

### 6. File Checkpointing (Rollback)

Enable for risky operations. Requires env var `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=1`.

```typescript
// Enable in options
options: {
  enableFileCheckpointing: true,
  extraArgs: { 'replay-user-messages': null } // Required to get checkpoint UUIDs
}

// Rollback logic
await query({
  prompt: "",
  options: { resume: sessionId }
}).rewindFiles(checkpointUuid);

```

### Available Tools Reference

* **File Ops**: `Read`, `Write`, `Edit`, `Glob`, `Grep`
* **Shell**: `Bash`, `BashOutput`, `KillBash`
* **Interaction** (user-facing, `sD1` set): `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `TaskOutput`
* **Delegation**: `Task`
* **Web**: `WebSearch`, `WebFetch`

> **Note**: Interaction tools require special handling in SDK subprocess mode — see "Multi-Turn Conversations & User Input Tools" section.

---

## Migration: V2 Session to query() for Orchestration

If you need project context (CLAUDE.md), hooks, MCP servers, or custom permissions, migrate from V2 to `query()`.

### Before (V2 - limited)
```typescript
const session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929',
});
await session.send(taskDescription);
for await (const msg of session.stream()) {
  handleMessage(msg);
}
```

### After (query - full options)
```typescript
const queryInstance = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    model: 'claude-sonnet-4-5-20250929',
    settingSources: ['project'],  // Loads CLAUDE.md automatically
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
    hooks: {
      PostToolUse: [{ hooks: [logToolUsage] }]
    }
  }
});

for await (const msg of queryInstance) {
  handleMessage(msg);
}
```

### Key Differences

| Aspect | V2 Session | query() |
|--------|------------|---------|
| Multi-turn | `session.send()` multiple times | Single prompt (use hooks for interaction) |
| Streaming | `session.stream()` | Async iterator directly |
| Cleanup | `session.close()` / `await using` | `abortController.abort()` |
| Resume | `unstable_v2_resumeSession(id)` | `options.resume: id` |

---

## Integration Test

**Location**: `apps/local-ui/src/test-query-integration.ts`

Run: `bun run test:integration` (from `apps/local-ui`)

Tests:
1. Creates temp workspace with unique marker in CLAUDE.md
2. Runs `query()` with `settingSources: ['project']`
3. Asks agent to report the marker from project instructions
4. Verifies CLAUDE.md was loaded by checking response contains marker

Expected output:
```
[PASS] Marker found in response - CLAUDE.md was loaded!
SUCCESS: query() correctly loaded CLAUDE.md via settingSources
```

---

## Multi-Turn Conversations & User Input Tools

> **Version investigated**: 0.2.37 (2025-02)

### How `streamInput` Works

`query()` returns a `Query` object with a `streamInput(stream)` method. This connects an `AsyncIterable<SDKUserMessage>` to the CLI subprocess's stdin:

```typescript
const inputStream = new MessageStream(); // custom async iterable
const queryInstance = query({ prompt, options });
queryInstance.streamInput(inputStream);   // connects to subprocess stdin

for await (const msg of queryInstance) {
  handleMessage(msg);
  if (msg.type === 'result') break;
}
```

When a message is enqueued on `inputStream`, `streamInput` serializes it as JSON and writes to the subprocess's stdin. The subprocess reads it and processes it as a user message in the conversation.

### SDKUserMessage Format

```typescript
interface SDKUserMessage {
  type: 'user';
  session_id: string;        // Must match the active session ID
  message: { role: 'user'; content: ContentBlock[] };
  parent_tool_use_id: string | null;  // Links response to a pending tool call
}
```

### ⚠️ CRITICAL: AskUserQuestion in SDK Mode

**Problem**: When the CLI subprocess encounters `AskUserQuestion` (or `ExitPlanMode`) tool calls, it handles them internally. In interactive CLI mode, a React/Ink component renders and blocks. In subprocess mode (no TTY), the CLI auto-resolves these tools — the session continues without waiting for user input.

**Symptoms**: Agent calls `AskUserQuestion`, the question UI flashes for ~5 seconds in local-ui, then the task terminates. The `result` message arrives before the user can respond.

**Root cause**: The CLI subprocess auto-resolves `AskUserQuestion` in non-interactive mode, sends a tool_result to Claude, Claude responds (often ending the conversation), and the `result` message is emitted — all within seconds.

**Fix** (implemented in local-ui): Set `parent_tool_use_id` and `session_id` correctly when sending the user's response:

```typescript
// In handleMessage — capture the tool_use block ID
if (toolName === 'AskUserQuestion') {
  const toolUseId = block.id; // from the assistant message content block
  worker.waitingFor = { ..., toolUseId };
}

// In sendMessage — link response to the tool call
session.inputStream.enqueue(buildUserMessage(answer, {
  parentToolUseId: worker.waitingFor?.toolUseId,
  sessionId: worker.sessionId,
}));
```

**Key details**:
- `block.id` on a `tool_use` content block is the tool_use_id (e.g., `toolu_abc123`)
- `worker.sessionId` is captured from the SDK's `system/init` message: `msg.session_id`
- Without correct `parent_tool_use_id`, the CLI treats the response as a new user message rather than a tool result
- The same pattern applies to `ExitPlanMode` (plan approval flow)

### Internal Tool Filtering (CLI internals)

The CLI has a set called `sD1` containing "user-facing" tools: `AskUserQuestion`, `ExitPlanMode`, `EnterPlanMode`, `TaskOutput`, and others. These are:
- **Available** in the main conversation (Claude can call them)
- **Filtered out** from subagent contexts via `kjA()` function
- **Not available** to `Task` subagents or hook agents

The base tool list comes from `b0(permissionContext)` → `ss()` which returns ALL tools. `sD1` tools are only removed when building tool lists for subagents/hooks.

### Debug Logging

The local-ui includes debug logging for the AskUserQuestion flow:
```
[Worker abc] AskUserQuestion detected — toolUseId=toolu_xyz, question="What output format?"
[Worker abc] Responding to tool_use toolu_xyz with sessionId=sess_12345
[MessageStream] enqueue: parent_tool_use_id=toolu_xyz, session_id=sess_12345..., hasWaiter=true
```

Warning when the bug recurs (result arrives while still waiting):
```
[Worker abc] ⚠️ Result received while still waiting — toolUseId=toolu_xyz
```

---

## Known Issues

### CLAUDE_CODE_OAUTH_TOKEN env var

If `CLAUDE_CODE_OAUTH_TOKEN` is set in the environment with an expired/invalid token, it will override valid credentials and cause 401 auth errors.

**Symptoms**: Agent returns `API Error: 401 {"type":"error","error":{"type":"authentication_error"...` as its response text.

**Fix**: Unset the env var or ensure it contains a valid token:
```bash
unset CLAUDE_CODE_OAUTH_TOKEN
```

Local-UI filters out this env var automatically when spawning queries.

---

## Investigation Notes (2025-02)

**How we verified V2 limitations:**

1. Searched `sdk.mjs` for option handling:
   ```bash
   rg -n "settingSources|cwd|systemPrompt|mcpServers" sdk.mjs
   ```

2. Found `SessionImpl` constructor hardcodes values:
   - Line ~8613: `settingSources: []`
   - Line ~8616: `mcpServers: {}`

3. Compared with `query()` function which properly extracts and passes all options via `ProcessTransport`.

4. Confirmed by TypeScript types: `SDKSessionOptions` only declares `model`, `env`, `executable`, `executableArgs`, `pathToClaudeCodeExecutable`, matching the runtime behavior.
