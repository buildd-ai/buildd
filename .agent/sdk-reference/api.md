# API Overview & Core Setup

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

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

> Status: `@alpha`, marked `UNSTABLE`. Officially described as "new V2 interface (preview)" in SDK docs.

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

```typescript
type SDKSessionOptions = {
  model: string;
  pathToClaudeCodeExecutable?: string;
  executable?: 'node' | 'bun' | 'deno';
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
