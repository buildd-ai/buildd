# New in v0.2.59 (CLI v2.1.59)

> Part of `.agent/claude-agent-sdk.md` docs. See index file for table of contents.

## Summary

SDK v0.2.53–v0.2.59 (CLI v2.1.53–v2.1.59) adds session management APIs, auto-memory, multi-agent memory optimization, and expanded Remote Control availability. Primarily a stability + developer experience release.

---

## Session Discovery: `listSessions()` (SDK v0.2.53)

Top-level function for discovering past sessions with metadata. Filter by project or list all.

```typescript
import { listSessions } from "@anthropic-ai/claude-agent-sdk";

const sessions = await listSessions({ dir: "/path/to/project", limit: 10 });

// SDKSessionInfo: sessionId, summary, lastModified, fileSize, customTitle?, firstPrompt?, gitBranch?, cwd?
```

---

## Session History: `getSessionMessages()` (SDK v0.2.59)

Read a session's full conversation history from its transcript file, with pagination.

```typescript
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";

const messages = await getSessionMessages(sessionId, { limit: 50, offset: 0 });
```

---

## Auto-Memory (CLI v2.1.59)

Claude automatically saves context to `~/.claude/projects/<project>/memory/MEMORY.md`. Manage with `/memory` command. Loaded when `settingSources` includes `'project'` or `'user'`.

- First 200 lines of MEMORY.md loaded per session
- Opt-in: `CLAUDE_CODE_DISABLE_AUTO_MEMORY=0`

---

## Multi-Agent Memory Optimization (CLI v2.1.59)

Completed subagent task state is now released from memory. Critical for long-running Buildd workers spawning many skills-as-subagents — prevents RSS growth.

---

## Remote Control Expanded (CLI v2.1.58)

`claude remote-control` (or `/rc`) rolled out to more users. Generates QR code / URL to control local sessions from mobile/browser. All traffic via Anthropic API over TLS.

---

## CLI v2.1.53–v2.1.59 Stability Fixes

| Version | Fix |
|---------|-----|
| 2.1.59 | MCP OAuth token refresh race condition (multiple instances); config file corruption (multiple instances); shell CWD-deleted error message |
| 2.1.59 | `/copy` command for code block selection; smarter bash always-allow prefix suggestions |
| 2.1.56 | VS Code Windows crash fix (another cause) |
| 2.1.55 | BashTool Windows EINVAL error fix |
| 2.1.53 | UI flicker fix; bulk agent kill aggregated notification; graceful shutdown stale Remote Control sessions; `--worktree` first-launch fix; Windows panic/WASM crash fixes |

---

## New/Expanded Options

| Option | Since | Description |
|--------|-------|-------------|
| `persistSession` | v0.2.52 | Default `true`. Set `false` to disable disk persistence |
| `spawnClaudeCodeProcess` | v0.2.52 | Custom spawn for VMs/containers/remote |
| `forkSession` | v0.2.52 | Fork to new session ID on resume |

### Expanded `AgentDefinition` Fields

| Field | Description |
|-------|-------------|
| `skills` | Preload skill names into agent context |
| `maxTurns` | Per-agent turn limit |
| `criticalSystemReminder_EXPERIMENTAL` | Critical reminder in system prompt |

### Expanded `CanUseTool` Parameters

New params: `blockedPath`, `decisionReason`, `toolUseID`, `agentID` — for fine-grained per-tool, per-agent permission decisions.

---

## Buildd Enhancement Opportunities

1. **P1: Bump SDK pin to `>=0.2.59`** — Get multi-agent memory fix, session APIs, MCP OAuth fix
2. **P1: Session history in dashboard** — `listSessions()` + `getSessionMessages()` for worker conversation browsing
3. **P2: Multi-agent memory stability** — Long-running local-ui workers benefit automatically from v2.1.59 memory fix
4. **P3: `persistSession: false` for ephemeral workers** — Reduce disk usage
5. **P3: `spawnClaudeCodeProcess` for remote execution** — Enable container/VM workers
6. **P3: Auto-memory for workers** — Cross-session learnings per workspace
