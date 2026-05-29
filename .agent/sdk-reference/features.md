# Claude Agent SDK — Feature Reference

**Last updated**: 2026-05-29
**Covering**: v0.2.114 → v0.3.156

---

## SDK Release Timeline (since last scan)

### v0.3.156 (2026-05-29) — current latest
- **Parity with Claude Code v2.1.156**
- **Bug fix**: Fixed Opus 4.8 thinking block modification causing API errors (important for Opus 4.8 sessions)

### v0.3.154 (2026-05-28)
- **Parity with Claude Code v2.1.154** — major feature release
- **Claude Opus 4.8**: New model available; SDK sessions can now use `claude-opus-4-8`; defaults to high-effort reasoning
- **Dynamic workflows**: Multi-agent workflow orchestration built into sessions; agents can spawn tens to hundreds of background sub-agents
- **Fast mode on Opus 4.8**: Available at reduced cost (2x standard rate, 2.5x speed)
- **Lean system prompt now default** for all models except Haiku, Sonnet, and Opus 4.7 and earlier
- **Streaming tool execution always enabled**: No longer behind a feature flag; works on Bedrock, Vertex, Foundry, and with telemetry disabled
- **Stdio MCP server env vars**: Subprocesses now receive `CLAUDE_CODE_SESSION_ID` and `CLAUDECODE=1` in their environment
- Multiple bug fixes: background sessions, worktree isolation for subagents, background session classifier, pinned session respawning

### v0.3.153 (2026-05-28) — superseded by 0.3.156
- **Parity with Claude Code v2.1.153** — primarily a bugfix and CLI parity release
- **`skipLfs` option** on `github`/`git` marketplace sources — skip Git LFS downloads during clone/update
- **Status line `COLUMNS`/`LINES` env vars** — status line commands now receive terminal dimensions
- Multiple bug fixes: MCP reconnect loop, OAuth gateway token routing, `Agent` tool subagent worktree, background session stability, Windows installer/updater issues

### v0.3.152 (2026-05-27)
- **`SessionStart` hook: `reloadSkills` return value** — hook can return `{ hookSpecificOutput: { reloadSkills: true } }` to trigger a skill re-scan without restarting the session
- **`SessionStart` hook: `sessionTitle` setter** — hook can return `{ hookSpecificOutput: { sessionTitle: "..." } }` to label the session
- **New `MessageDisplay` hook event** — fires before assistant messages are displayed; hooks can transform or suppress the text

### v0.3.150 (2026-05-23)
- Parity with Claude Code v2.1.150

### v0.3.149 (2026-05-22)
- **Bug fix**: `options.env` no longer drops `CLAUDE_AGENT_SDK_VERSION` env var when a custom env map is provided
- **Docs clarification**: `Options.env` **replaces** the subprocess environment (does not merge with `process.env`)

### v0.3.148 (2026-05-22)
- Parity with Claude Code v2.1.148

### v0.3.147 – v0.3.146 – v0.3.145 (2026-05-19 – 2026-05-21)
- Parity releases (Claude Code v2.1.145–147)

### v0.3.144 (2026-05-19)
- `error: 'model_not_found'` on result messages when the selected model is unavailable (was generic `'invalid_request'`)
- Added `@anthropic-ai/claude-agent-sdk/extract` export for bun build --compile consumers

### v0.3.143 (2026-05-15)
- `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` moved from `dependencies` to `peerDependencies`. Both are still bundled — runtime unaffected, but yarn classic users should add them explicitly.

### v0.3.142 (2026-05-14) — **BREAKING**
- **Removed** v2 session API: `unstable_v2_createSession`, `unstable_v2_resumeSession`, `unstable_v2_prompt`, `SDKSession`, `SDKSessionOptions` (deprecated since 0.2.133). Use `query()` instead.
- **MCP non-blocking by default**: servers now connect in the background; sessions start immediately; slow servers report `status: "pending"` in `init`. Set `MCP_CONNECTION_NONBLOCKING=0` to restore old wait-up-to-5s behavior, or `alwaysLoad: true` on individual servers to require them by turn 1.
- **Task tools replace TodoWrite**: headless/SDK sessions now use `TaskCreate`/`TaskUpdate`/`TaskGet`/`TaskList` instead of `TodoWrite` (deprecated since 0.2.136)
- Added `request_id`, `subagent_type`, `task_description` on SDK message types and task system events
- Headless sessions exit non-zero with stderr diagnostic on permanent transport close (401/403/404)

### v0.2.141 (2026-05-13)
- Exported Task tool types (`TaskCreateInput/Output`, `TaskGetInput/Output`, `TaskUpdateInput/Output`, `TaskListInput/Output`) from `@anthropic-ai/claude-agent-sdk/sdk-tools`
- Aligned `@anthropic-ai/sdk` peer to ^0.93.0

### v0.2.136 (2026-05-08)
- Added `resolveSettings()` (alpha) — inspect effective merged settings without spawning the CLI
- **Deprecated** `TodoWrite` — future versions switching to Task tools

### v0.2.133 (2026-05-07)
- **Deprecated** v2 session API (`unstable_v2_*`)
- **Deprecated** `'Skill'` in `allowedTools` — use `skills` option instead

### v0.2.132 (2026-05-06)
- `applyFlagSettings()` documented; added `null` support on top-level keys to clear overrides

### v0.2.126 (2026-05-01)
- Added `origin` to result messages (`SDKResultSuccess`/`SDKResultError`) — distinguishes user-prompted results from `task-notification` followups

### v0.2.121 (2026-04-28)
- Added `updatedToolOutput` to `PostToolUseHookSpecificOutput` for replacing any tool output
- Deprecated `updatedMCPToolOutput`

---

## Core API Reference

### `query(options)`
Main entry point. Returns an async iterable of `SDKMessage` events.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';

const session = query({
  prompt: 'Your task description',
  options: {
    model: 'claude-sonnet-4-6',
    allowedTools: ['Read', 'Write', 'Bash'],
    skills: ['skill-slug'],           // preferred over 'Skill' in allowedTools (since 0.2.133)
    maxTurns: 50,
    hooks: {
      PreToolUse: [permissionHook],
      SessionStart: [sessionStartHook],
      MessageDisplay: [displayHook],  // new in 0.3.152
    },
    env: { MY_VAR: 'value' },         // REPLACES subprocess env (not merged) — since 0.3.149 docs
  }
});

for await (const msg of session) {
  // SDKMessage types: assistant, user, system, result, ...
}
```

### `HookCallback`
```ts
type HookCallback = (input: unknown) => Promise<HookResult>;

// PreToolUse: allow/deny/modify tool calls
// SessionStart: observe startup, set title, trigger skill reload  
// SessionEnd: observe termination
// Notification: observe agent notifications
// ConfigChange: observe/block config file changes
// PostToolUse: replace tool output
// MessageDisplay: transform/suppress assistant message text (new in 0.3.152)
```

### Message types with `origin` (since v0.2.126)
```ts
// Distinguish user-prompted results from task-notification followups
if (msg.type === 'result' && msg.origin?.type === 'task-notification') {
  // background task result, not a direct user interaction
}
```

### `resolveSettings()` alpha (since v0.2.136)
```ts
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
const settings = await resolveSettings();
// Returns effective merged settings without spawning the CLI
```
