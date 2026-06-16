# Claude Agent SDK Reference

**Current version in Buildd**: `^0.3.178` (latest released: `0.3.178`)
**Last updated**: 2026-06-16

This index covers the SDK features and integration patterns relevant to Buildd's worker runner.

## Reference files

- [features.md](sdk-reference/features.md) — SDK feature inventory with version notes
- [advanced.md](sdk-reference/advanced.md) — Hook patterns and advanced usage
- [integration-status.md](sdk-reference/integration-status.md) — Version tracking and enhancement backlog

## Quick API summary

Buildd's integration is in `packages/core/worker-runner.ts` and `apps/runner/src/hook-factory.ts`.

```ts
import { query, type HookCallback, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Core usage pattern
const queryInstance = query({
  prompt: taskPrompt,
  options: { /* ClaudeCodeOptions */ }
});

for await (const message of queryInstance) {
  // handle SDKMessage events
}
```

## Key APIs used by Buildd

| API | Usage |
|-----|-------|
| `query()` | Main session runner — iterates SDK messages |
| `queryInstance.supportedModels()` | Model capability discovery at session start |
| `HookCallback` | PreToolUse, SessionStart, SessionEnd, Notification, ConfigChange hooks |
| `hookSpecificOutput.permissionDecision` | Allow/deny tool calls from PreToolUse hook |
| `hookSpecificOutput.sessionTitle` | Set session display name (v0.3.152+) |
| `reloadSkills` in SessionStart | Hot-reload skills mid-session (v0.3.152+) |
