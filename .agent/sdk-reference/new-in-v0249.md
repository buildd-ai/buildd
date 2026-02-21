# New in v0.2.49 (CLI v2.1.49)

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## 32. ConfigChange Hook Event

Fires when configuration files (CLAUDE.md, .claude/settings.json, etc.) change during a session. Enables enterprise security auditing and optional blocking of settings changes.

```typescript
type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange';
  file_path: string;      // Path to the changed config file
  change_type: string;    // Type of change (created, modified, deleted)
};

// Block config changes via hook output:
hooks: {
  ConfigChange: [{
    hooks: [async (input) => ({
      decision: 'block',
      reason: 'Config changes not allowed during execution',
    })]
  }]
}
```

**Buildd use case**: Audit trail for workspace config changes; optionally block agents from modifying their own CLAUDE.md instructions.

---

## 33. Model Capability Discovery

SDK model info now includes capability fields for dynamic UI/config:

```typescript
// From supportedModels():
type ModelInfo = {
  // ... existing fields ...
  supportsEffort: boolean;              // Whether model supports effort parameter
  supportedEffortLevels: string[];      // e.g. ['low', 'medium', 'high', 'max']
  supportsAdaptiveThinking: boolean;    // Whether model supports adaptive thinking
};
```

**Buildd use case**: Dynamically show/hide effort and thinking controls in workspace config based on selected model's capabilities, rather than hardcoding model lists.

---

## 34. Worktree Isolation for Subagents

Agent definitions support `isolation: "worktree"` for git worktree isolation:

```typescript
options: {
  agents: {
    'deploy': {
      description: 'Handles deployment',
      prompt: 'You are a deployment specialist...',
      tools: ['Read', 'Bash', 'Edit', 'Write'],
      model: 'inherit',
      isolation: 'worktree',    // Run in isolated git worktree
      background: true,         // Run in background
    }
  }
}
```

**Buildd use case**: Skills-as-subagents can run in isolated worktrees to avoid conflicts with the main worker's file changes. Controlled via `gitConfig.useWorktreeIsolation` workspace setting.

---

## 35. Sonnet 4.6 with 1M Context

Sonnet 4.5 with 1M context is being removed from the Max plan. Sonnet 4.6 now has 1M context support. Update `betas` usage to target Sonnet 4.6:

```typescript
options: {
  model: 'claude-sonnet-4-6',  // NOT 4.5
  betas: ['context-1m-2025-08-07'],
}
```

---

## 36. Permission Suggestions on Safety Checks

`permission_suggestions` field on `PermissionRequestHookInput` is now populated when safety checks trigger ask responses. Previously the field existed but was often empty. SDK consumers can now display actionable permission options to users.

---

## 37. v2.1.49 Performance & Stability Improvements

- **WASM memory fix**: Fixed unbounded WASM/Yoga memory growth during long sessions by periodic parser resets
- **Non-interactive perf**: Skips unnecessary API calls during `-p` mode startup — benefits all Buildd workers
- **MCP auth caching**: Caches authentication failures for HTTP/SSE MCP servers, avoiding repeated connection attempts
- **Startup perf**: Analytics token counting reduced; MCP tool token counting batched into single API call
- **CWD recovery**: Shell commands no longer permanently fail after a command deletes its own working directory
- **`disableAllHooks` fix**: Non-managed settings can no longer disable managed hooks set by enterprise policy (security fix)
- **Ctrl+C/ESC fix**: No longer silently ignored when background agents are running; pressing twice within 3s kills all background agents
- **`--resume` picker fix**: Sessions starting with `/clear` no longer show raw XML tags in picker
