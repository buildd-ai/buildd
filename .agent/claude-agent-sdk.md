## Agent SDK Usage (@anthropic-ai/claude-agent-sdk)

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

Preferred for multi-turn orchestration. Use `await using` for automatic cleanup.

```typescript
import { unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';

// Create new session
await using session = unstable_v2_createSession({
  model: 'claude-sonnet-4-5-20250929'
});

// Resume existing session (e.g., after pause/restart)
await using resumedSession = unstable_v2_resumeSession(sessionId, {
  model: 'claude-sonnet-4-5-20250929'
});

// Forking: To branch a session, use query() with { resume: id, forkSession: true }

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
