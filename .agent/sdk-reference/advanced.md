# Claude Agent SDK — Advanced Usage

**Last updated**: 2026-05-27

---

## Hook System

All hooks in Buildd are registered on the `query()` options and implemented as `HookCallback` functions.

### PreToolUse hook (permission enforcement)

Buildd's `HookFactory.createPermissionHook()` in `apps/runner/src/hook-factory.ts` enforces:
- Blocks `AskUserQuestion` in autonomous mode
- Blocks dangerous bash patterns (`DANGEROUS_PATTERNS`)
- Blocks writes to sensitive paths (`SENSITIVE_PATHS`)
- Explicitly allows safe Bash commands (prevents `acceptEdits` stall)

```ts
const hook: HookCallback = async (input) => {
  if ((input as any).hook_event_name !== 'PreToolUse') return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow' | 'deny',
      permissionDecisionReason: 'reason string',
    },
  };
};
```

### PostToolUse hook (tool output replacement)

Use `updatedToolOutput` (since v0.2.121) to replace output from any tool. `updatedMCPToolOutput` is deprecated.

```ts
return {
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    updatedToolOutput: 'replacement output',
  },
};
```

### SessionStart hook (v0.3.152 enhancements)

Buildd's current `sessionStartHook` in `packages/core/worker-runner.ts` is observational (`async: true`). Two new return values are now available:

**Set session title** (useful for identifying sessions in Claude logs):
```ts
return {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    sessionTitle: `buildd-task-${task.id.slice(0, 8)}`,
  },
};
```

**Trigger skill reload** (hot-reload skills without restarting):
```ts
return {
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    reloadSkills: true,
  },
};
```

### MessageDisplay hook (new in v0.3.152)

Fires before assistant messages are displayed. Hooks can transform or suppress text. Useful for:
- Filtering sensitive output from Buildd's dashboard stream
- Adding context or formatting to displayed messages
- Audit logging of raw assistant output before display

```ts
const displayHook: HookCallback = async (input) => {
  if ((input as any).hook_event_name !== 'MessageDisplay') return {};
  const text = (input as any).message as string;
  // Return modified text, empty string to suppress, or {} to pass through
  return {};
};
```

---

## `options.env` Behavior (clarified in v0.3.149)

`Options.env` **replaces** the subprocess environment — it does NOT merge with `process.env`. To pass extra vars while keeping current env:

```ts
options: {
  env: {
    ...process.env,          // copy current environment
    BUILDD_TASK_ID: task.id, // add/override specifics
    // CLAUDE_AGENT_SDK_VERSION is now preserved automatically (bug fix in 0.3.149)
  }
}
```

---

## MCP Non-Blocking Connections (since v0.3.142)

MCP servers now connect in the background by default. Sessions start immediately; slow servers show `status: "pending"` in the `init` event until ready.

To require a specific server by turn 1:
```json
{
  "mcpServers": {
    "my-critical-server": {
      "alwaysLoad": true
    }
  }
}
```

To restore old blocking behavior:
```sh
MCP_CONNECTION_NONBLOCKING=0 bun run worker
```

---

## Task Tools (replaced TodoWrite since v0.3.142)

Agents now use `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` instead of `TodoWrite`. This is internal agent behavior — Buildd's SDK integration layer is unaffected. However, Buildd's E2E tests or message parsing that expects `TodoWrite` in the transcript should be updated.

Tool input/output types are exported from `@anthropic-ai/claude-agent-sdk/sdk-tools`:
```ts
import type { TaskCreateInput, TaskUpdateInput } from '@anthropic-ai/claude-agent-sdk/sdk-tools';
```

---

## Model Not Found Errors (since v0.3.144)

When a model doesn't exist or isn't available, result messages now report `error: 'model_not_found'` instead of the generic `'invalid_request'`. Buildd's `discoverModelCapabilities()` can distinguish this case:

```ts
if (msg.type === 'result' && msg.isError && msg.error === 'model_not_found') {
  // fall back to default model
}
```

---

## Bun Build --compile Support (since v0.3.144)

For packaging the runner as a compiled binary:
```ts
import { extractFromBunfs } from '@anthropic-ai/claude-agent-sdk/extract';
import binPath from '@anthropic-ai/claude-agent-sdk-linux-x64/bin' with { type: 'file' };

const executablePath = await extractFromBunfs(binPath);
// pass to options.pathToClaudeCodeExecutable
```
