## Agent SDK Usage (@anthropic-ai/claude-agent-sdk)

> **Version investigated**: 0.1.77

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
* **Interaction**: `AskUserQuestion`, `TodoWrite`
* **Delegation**: `Task`
* **Web**: `WebSearch`, `WebFetch`

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
