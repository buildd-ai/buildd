# New in SDK v0.2.49 / CLI v2.1.49

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 32. ConfigChange Hook Event

**Type**: `HookEvent = 'ConfigChange'`

Fires when configuration files (CLAUDE.md, settings.json, etc.) change during a session. Enables enterprise security auditing and optional blocking of settings changes.

```typescript
type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange';
  file_path: string;
  change_type: string;
};

// Hook can block changes:
hooks: {
  ConfigChange: [{
    hooks: [async (input) => {
      if (isSensitivePath(input.file_path)) {
        return { decision: 'block', reason: 'Config changes blocked by policy' };
      }
      return {};
    }]
  }]
}
```

**Buildd status**: Integrated in both `worker-runner.ts` and `local-ui/workers.ts`.

---

## 33. Model Capability Discovery

**Method**: `queryInstance.supportedModels()`

SDK model info now includes fields for discovering model capabilities at runtime:

```typescript
// Fields on model info objects:
{
  supportsEffort: boolean;           // Whether model supports effort levels
  supportedEffortLevels: string[];   // e.g. ['low', 'medium', 'high', 'max']
  supportsAdaptiveThinking: boolean; // Whether model supports adaptive thinking
}
```

Use to validate `effort` and `thinking` configuration against actual model capabilities before starting work.

**Buildd status**: Integrated in both `worker-runner.ts` and `local-ui/workers.ts`. Validates configured effort/thinking and emits `worker:model_capabilities` warnings for unsupported options.

---

## 34. Worktree Isolation for Subagents

**Option**: `isolation: 'worktree'` on agent definitions

When set, each subagent runs in its own temporary git worktree, preventing file conflicts during parallel work. Requires git repo context.

```typescript
agents: {
  'code-reviewer': {
    description: 'Review code quality',
    prompt: 'You are a code reviewer...',
    tools: ['Read', 'Grep', 'Glob'],
    model: 'inherit',
    isolation: 'worktree',  // SDK v0.2.49+
  }
}
```

**Buildd status**: Integrated. Controlled by `useWorktreeIsolation` in workspace gitConfig (task-level override > workspace-level).

---

## 35. Sonnet 4.6 with 1M Context

Sonnet 4.5 with 1M context is being removed from Max plan in favor of Sonnet 4.6 with 1M context. The beta identifier remains the same:

```typescript
betas: ['context-1m-2025-08-07']
```

**Buildd status**: Already integrated. `extendedContext` config conditionally adds the beta for Sonnet models.

---

## 36. Permission Suggestions on Safety Checks

Permission suggestions are now populated when safety checks trigger an ask response, enabling SDK consumers to display permission options to users.

```typescript
// In PermissionRequest hook:
type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest';
  tool_name: string;
  tool_input: unknown;
  permission_suggestions?: PermissionUpdate[];  // Now populated by safety checks
};
```

**Buildd status**: Integrated in local-ui via PermissionRequest hook handling.

---

## 37. Background Agent Definitions (CLI v2.1.49)

Agent definitions support `background: true` to always run as background tasks:

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

**Buildd status**: Not yet integrated. Potential enhancement for long-running monitoring agents.

---

## 38. CLI `--worktree` (`-w`) Flag (CLI v2.1.49)

Start Claude in an isolated git worktree from the CLI:

```bash
claude --worktree  # or claude -w
```

This is distinct from SDK-level `isolation: 'worktree'` on subagents. The CLI flag creates a worktree for the entire session.

**Buildd status**: Not applicable (Buildd workers already use worktrees via the Buildd platform). Could be useful for `apps/agent/` CLI mode.

---

## 39. Plugin Settings (CLI v2.1.49)

Plugins can now ship `settings.json` for default configuration. Plugin enable/disable scope auto-detection also fixed.

**Buildd status**: Not yet relevant. Could be useful if Buildd creates distributable plugins.

---

## Key Bug Fixes in v2.1.49

| Fix | Impact on Buildd |
|-----|-----------------|
| **WASM memory fix** — Fixed unbounded WASM memory growth during long sessions | Critical for long-running workers |
| **CWD recovery** — Shell commands no longer permanently fail after a command deletes its own working directory | Reliability improvement |
| **Non-interactive performance** — Improved performance in `-p` mode | Benefits all Buildd workers |
| **MCP auth caching** — Reduced redundant network requests for MCP OAuth | Faster MCP server startup |
| **Ctrl+C/ESC fix** — No longer silently ignored when background agents running | Reliability for agent teams |
| **`disableAllHooks` hierarchy** — Now respects managed settings hierarchy | Enterprise deployment correctness |
| **Prompt cache regression fix** — Fixed regression that reduced cache hit rates | Cost reduction |
