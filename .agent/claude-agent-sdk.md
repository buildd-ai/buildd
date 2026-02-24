## Agent SDK Usage (@anthropic-ai/claude-agent-sdk)

**Version documented**: 0.2.52 (CLI parity: v2.1.52, Feb 24 2026)

### Monorepo SDK Versions

| Package | Version | Notes |
|---------|---------|-------|
| `packages/core` | `>=0.2.49` | Bump to `>=0.2.52` recommended |
| `apps/agent` | `>=0.2.49` | Bump to `>=0.2.52` recommended |
| `apps/local-ui` | `>=0.2.49` | Bump to `>=0.2.52` recommended |

---

## Reference Files

Load only what you need:

| File | Contents |
|------|----------|
| [sdk-reference/api.md](sdk-reference/api.md) | API overview, `query()` vs V2 Session, Local-UI implementation, core integration pattern |
| [sdk-reference/features.md](sdk-reference/features.md) | Features 2–31, 37: Sandbox, 1M context, Plugins, Structured Outputs, Budget, Hooks (all types), MCP annotations, Agent Teams, Memory, Checkpointing, Background Agents, etc. |
| [sdk-reference/new-in-v0249.md](sdk-reference/new-in-v0249.md) | Features 32–36: ConfigChange hook, model capability discovery, worktree isolation, Sonnet 4.6 1M context, v2.1.49 improvements |
| [sdk-reference/new-in-v0252.md](sdk-reference/new-in-v0252.md) | Features 38–52: WorktreeCreate/Remove hooks, memory leak fixes, `claude remote-control`, account env vars, tool result disk threshold, security fixes, headless startup perf |
| [sdk-reference/integration-status.md](sdk-reference/integration-status.md) | What Buildd uses today, pending tasks, completed integrations, full CLI changelog |
| [sdk-reference/advanced.md](sdk-reference/advanced.md) | Full options table, all query methods, SDKMessage types, observability hooks, MCP setup, multi-turn/`streamInput`, known issues |

---

## Quick Start

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

const result = query({
  prompt: taskDescription,
  options: {
    cwd: workspacePath,
    settingSources: ['project'],       // auto-loads CLAUDE.md
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'acceptEdits',
    env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' },
    allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task'],
    abortController,
  }
});

for await (const msg of result) {
  if (msg.type === 'result') break;
}
```

**Rule**: Use `query()` (V1) for Buildd workers — it supports all options including `cwd`, `settingSources`, `mcpServers`, `agents`, `sandbox`, etc. V2 Session API is for simple interactive sessions only.
