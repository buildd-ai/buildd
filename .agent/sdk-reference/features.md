# Claude Agent SDK — Feature Reference

**Last updated**: 2026-06-18
**Covering**: v0.2.114 → v0.3.181

---

## SDK Release Timeline (since last scan)

### v0.3.181 (2026-06-17) — current latest
- **Parity with Claude Code v2.1.181**
- **`SDKRateLimitInfo` enhanced fields**: `errorCode`, `canUserPurchaseCredits`, and `hasChargeableSavedPaymentMethod` added to rate limit info — allows callers to detect when a session is blocked due to insufficient credits vs. API overload, and whether the user can resolve it by purchasing credits
- **`tool_use_meta.icon_url`**: Assistant messages with `tool_use_meta` sidecar now include an `icon_url` per tool call, populated from MCP server directory metadata — enables dashboard display of MCP tool icons alongside human-readable labels (extends the v0.3.179 `tool_use_meta` feature)
- **Bug fix**: SDK-hosted Remote Control sessions no longer drop `file_attachments` from inbound user messages

### v0.3.179 (2026-06-16)
- **Parity with Claude Code v2.1.179**
- **`tool_use_meta` sidecar on assistant messages**: Optional field attached to assistant messages with display-friendly names for tool calls — SDK consumers can render human-readable labels instead of raw wire names (relevant to Buildd dashboard tool display)
- **Bug fix (Buildd-relevant)**: `-p` mode no longer exits before a completed background agent's notification is delivered — previously interim text could ship as the final result
- **Bug fix (Buildd-relevant)**: Remote (stream-json) sessions no longer appear busy for the full duration of a background workflow — turn result is now emitted at the turn boundary; session reports idle while background tasks continue

### v0.3.178 (2026-06-15)
- **Parity with Claude Code v2.1.178**
- **`Tool(param:value)` permission rule syntax**: Match tool calls by input parameter value, e.g. `Agent(model:opus)` to block Opus subagents, `Bash(command:rm*)` to deny `rm` commands — adds fine-grained PreToolUse control beyond tool name
- **Skills in nested `.claude/skills` directories**: Skills now load when working on files in nested directories; name clash resolved with `<dir>:<name>` prefix — relevant to Buildd's skill delivery in nested worktrees
- **Nested `.claude/` closest-wins**: Agent, workflow, and output-style configs resolve to the nearest `.claude/` directory; project-scope workflow saves target the closest existing `.claude/workflows/`
- **Auto mode: subagent spawns evaluated by classifier before launch**: Closes a gap where a subagent could request a blocked action without review — affects Buildd workers using auto mode
- **Bug fix (Buildd-relevant)**: Fixed OOM crash when CLI inherits stale websocket/OAuth file-descriptor env vars from parent process — affects Buildd workers that inherit subprocess env
- **Bug fix (Buildd-relevant)**: Fixed workers failing with `401 Invalid bearer token` when daemon started from shell with custom `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
- **Bug fix**: Fixed compaction not honoring `--fallback-model`; compaction now uses configured fallback model chain on overload/availability errors
- **Bug fix**: Fixed model requests continuing to fail with auth errors after credentials refreshed outside the session (stale cached request config)
- **Bug fix**: Fixed nested `.claude/skills` skills with directory-qualified names being blocked by permission prompts in non-interactive runs
- **Bug fix**: Fixed background sessions created with `/bg` showing "Working" forever in agents list
- Improved `/doctor` with flat tree layout, clearer status icons, highlighted command names
- Changed workflow prompt keyword to require explicit phrases like "run a workflow" or "workflow:" (purple shimmer highlight)

### v0.3.177 (2026-06-13)
- **Parity with Claude Code v2.1.177** — no user-facing changes

### v0.3.176 (2026-06-12)
- **Parity with Claude Code v2.1.176**
- **Bug fix (Buildd-relevant)**: Hook `if` conditions for Read/Edit/Write tool paths now match correctly — patterns like `Edit(src/**)`, `Read(~/.ssh/**)`, `Read(.env)` were previously broken
- **Bug fix**: Linux sandbox no longer fails to start when `.claude/settings.json` is a symlink with an absolute target — affects Buildd workers using symlinked config
- Session titles now generated in the language of your conversation (`language` setting to pin)
- `footerLinksRegexes` setting for regex-matched footer link badges
- Improved Bedrock credential caching: credentials from `awsCredentialExport` cached until their `Expiration` (was fixed 1 hour)
- Fixed `availableModels` enforcement: alias model picks can't bypass via `ANTHROPIC_DEFAULT_*_MODEL`; `/fast` refuses when target model is outside allowlist

### v0.3.175 (2026-06-12)
- **Parity with Claude Code v2.1.175**
- **`enforceAvailableModels` managed setting**: When enabled, `availableModels` also constrains the Default model (falls back to first allowed model); user/project settings can no longer widen a managed allowlist — relevant to Buildd role-based model restrictions

### v0.3.174 (2026-06-11)
- **Parity with Claude Code v2.1.174**
- **Bug fix (Buildd-relevant)**: Background sessions no longer inherit another session's `ANTHROPIC_*` provider env (gateway URL, custom headers, model aliases) from the shell that started the daemon — affects Buildd workers on pre-warmed runners
- **Bug fix**: Workflow `agent()` subagents now include per-agent attribution headers — improves traceability in multi-agent workflows
- **Bug fix**: Skill hot-reload now only re-announces changed skills (not the full listing) — reduces noise during skill updates
- `wheelScrollAccelerationEnabled` setting to disable mouse-wheel scroll acceleration in fullscreen mode
- Fixed Bedrock GovCloud regions (`us-gov-*`) deriving wrong inference profile prefix

### v0.3.173 (2026-06-11)
- **Parity with Claude Code v2.1.173**
- **Bug fix**: Fable 5 model names with `[1m]` suffix now stripped automatically — no manual normalization needed
- Bug fix: spurious "sandbox dependencies missing" startup warning on Windows

### v0.3.172 (2026-06-10)
- **Parity with Claude Code v2.1.172**
- **Sub-agents can now spawn sub-agents (up to 5 levels deep)**: Recursive multi-agent orchestration now supported natively
- **Bug fix (critical for Buildd)**: Background agents no longer read another directory's project settings (`.mcp.json` approvals, trust) when dispatched onto a pre-warmed worker
- **`availableModels` restrictions now applied to subagent model overrides**: Role-based model restrictions are properly enforced across nested agents
- OTEL metric `claude_code.lines_of_code.count` now includes a `model` attribute for per-model slicing
- Bug fix: 1M context sessions no longer get permanently stuck — auto-compacts back under standard limit
- Bug fix: model IDs no longer get a doubled `[1M][1m]` suffix

### v0.3.170 (2026-06-09)
- **Parity with Claude Code v2.1.170**
- **Claude Fable 5 (Mythos-class) model**: New model available via SDK sessions — check Anthropic docs for model ID
- Bug fix: sessions not saving transcripts (not appearing in `--resume`) when launched from VS Code integrated terminal or shells inheriting Claude Code env vars

### v0.3.169 (2026-06-08)
- **Parity with Claude Code v2.1.169**
- **`--safe-mode` / `CLAUDE_CODE_SAFE_MODE`**: Start Claude Code with all customizations (CLAUDE.md, plugins, skills, hooks, MCP servers) disabled — useful for Buildd worker troubleshooting
- **`disableBundledSkills` setting / `CLAUDE_CODE_DISABLE_BUNDLED_SKILLS`**: Hide bundled skills, workflows, and built-in slash commands from the model — useful in tightly-scoped Buildd roles
- **`/cd` command**: Move a session to a new working directory without breaking the prompt cache
- **Bug fix (Buildd-relevant)**: Background agents now correctly apply project-level settings `env` values (e.g. `ANTHROPIC_MODEL`) when dispatched onto a pre-warmed worker
- **`claude agents --json` improvements**: Blocked and just-dispatched sessions now included; `--all` includes completed sessions; new `id` and `state` fields
- `TaskCreate` reliability improved — malformed inputs are repaired automatically; validation errors for unloaded tools include the schema
- CLAUDE.md length warning threshold now scales with the model's context window
- Restored 5-minute idle timeout on Vertex/Foundry (`API_FORCE_IDLE_TIMEOUT=0` to opt out)

### v0.3.168 (2026-06-06)
- **Parity with Claude Code v2.1.168** — bug fixes and reliability improvements

### v0.3.167 (2026-06-06)
- **Parity with Claude Code v2.1.167** — bug fixes and reliability improvements

### v0.3.166 (2026-06-06)
- **Parity with Claude Code v2.1.166**
- **`fallbackModel` setting**: Configure up to 3 fallback models tried in order when the primary model is overloaded or unavailable; `--fallback-model` also applies to interactive sessions
- **Glob patterns in deny rules**: `"*"` in tool-name position denies all tools; unknown tool names in deny rules warn at startup
- **`SendMessage` hardened**: Messages relayed via `SendMessage` from other Claude sessions no longer carry user authority — receivers refuse relayed permission requests, auto mode blocks them
- `MAX_THINKING_TOKENS=0` / `--thinking disabled` now disables thinking on API models that think by default
- Bug fix: remote sessions permanently stuck when a brief backend disruption occurred during worker registration at startup

### v0.3.165 (2026-06-05)
- **Parity with Claude Code v2.1.165** — bug fixes and reliability improvements

### v0.3.163 (2026-06-04)
- **Parity with Claude Code v2.1.163**
- **`requiredMinimumVersion` / `requiredMaximumVersion` managed settings**: Claude Code refuses to start if its version is outside the allowed range
- **Stop/SubagentStop hooks: `additionalContext` return value**: Hooks can now return `hookSpecificOutput.additionalContext` to give Claude feedback and keep the turn going without being labeled a hook error
- Bug fix: `claude -p` no longer hangs after its final result when a background command never exits — background shells are stopped ~5s after result once stdin closes
- Bug fix: `claude -p` no longer fails with "ANTHROPIC_API_KEY required" on Bedrock/Vertex/Foundry when `CI=true` and no Anthropic API key is set
- Bug fix: Bash commands failing under bazel and EDR-protected Go workflows (regression in 2.1.154)

### v0.3.162 (2026-06-03)
- **Parity with Claude Code v2.1.162**
- **`claude agents --json` adds `waitingFor` field**: Programmatic callers can now read what a waiting session is blocked on (e.g. tool name or input prompt)
- **`WebFetch(domain:...)` permission rules take precedence over preapproved hosts**: Explicit domain rules now override blanket preapprovals — more precise permission control
- Bug fixes: Windows permission rules not matching backslashes/case-variant paths; MCP per-server `timeout` values below 1000ms incorrectly floored; `claude agents` truncating long session names; image paste (`Ctrl+V`) failing in agents view
- Quieter startup with grouped notices and clearer startup warnings

### v0.3.161 (2026-06-02)
- **Parity with Claude Code v2.1.161**
- **`OTEL_RESOURCE_ATTRIBUTES` values included as metric labels**: Custom dimension slicing in OpenTelemetry dashboards
- **`claude agents` progress view**: Rows now show `done/total` count and longest-running item in peek
- **Parallel tool calls: failed Bash commands no longer cancel sibling calls**: Improves resilience when one parallel command errors
- Bug fixes: `/effort` dialog motion setting, background subagent output corrupting `claude -p` stdout, OpenTelemetry log events dropped before init, `claude mcp` commands printing secrets

### v0.3.160 (2026-06-02)
- **Parity with Claude Code v2.1.160**
- **Safety prompts before writing to shell startup files** (`.zshenv`, `.bash_login`, etc.): Extra guard before modifying shell init scripts
- **`acceptEdits` mode prompts before writing build-tool config files**: Additional confirmation step for build config changes
- Bug fixes: background sessions dropping chat history on reattach, Windows clipboard with WSL, keyboard responsiveness under heavy CPU load, CJK IME composition in agents view

### v0.3.159 (2026-05-31)
- **Parity with Claude Code v2.1.159** — internal infrastructure improvements, no user-facing changes

### v0.3.158 (2026-05-30)
- **Parity with Claude Code v2.1.158**
- **Auto mode on Bedrock/Vertex/Foundry**: Opus 4.7 and Opus 4.8 now support auto mode on enterprise AI platforms; opt in with `CLAUDE_CODE_ENABLE_AUTO_MODE=1`

### v0.3.157 (2026-05-30)
- **Parity with Claude Code v2.1.157** — feature-heavy release
- **Skills auto-loaded from `.claude/skills`**: Plugins in `.claude/skills` directories are now automatically loaded; no marketplace entry required
- **`claude plugin init <name>`**: Scaffold a new plugin directly in `.claude/skills`
- **`agent` field in `settings.json` honored for dispatched sessions**: Workers can specify a preferred agent role; override with `--agent <name>`
- **`EnterWorktree` can switch between Claude-managed worktrees mid-session**: Allows dynamic worktree switching without restarting
- **Worktrees unlocked after agent finishes**: Claude-managed worktrees are left unlocked on completion, so `git worktree remove`/`prune` can clean them up
- **`tool_decision` telemetry**: Events now include `tool_parameters` (bash commands, MCP/skill names) when `OTEL_LOG_TOOL_DETAILS=1`
- Bug fixes: sandbox network permission prompts in SDK mode, background subagent worktree orphaning, `--resume` session picker, `--worktree` returning to wrong directory

### v0.3.156 (2026-05-29)
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
