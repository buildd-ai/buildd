# Python Agent SDK Evaluation for Buildd Workers

**Date**: 2026-02-18
**SDK Version Evaluated**: `claude-agent-sdk` v0.1.37 (PyPI), bundled CLI v2.1.45
**TypeScript SDK Baseline**: `@anthropic-ai/claude-agent-sdk` v0.2.45

---

## Executive Summary

**Recommendation: Do not adopt the Python Agent SDK for Buildd workers.**

Both the Python and TypeScript SDKs are CLI wrapper libraries that spawn the same Node.js Claude Code CLI subprocess. The Python SDK adds a Python→Node.js indirection layer without providing meaningful benefits for Buildd's use case, while introducing feature parity gaps, deployment complexity, and a language boundary that complicates the existing TypeScript monorepo.

---

## 1. Architecture: Both SDKs Are CLI Wrappers

The most important finding: **the Python SDK does NOT call the Anthropic API directly**. It spawns the Claude Code CLI as a subprocess, identical to the TypeScript SDK.

### Python SDK Architecture

```
Python process → SubprocessCLITransport → claude (Node.js CLI) → Anthropic API
```

Source code confirms this:
- `SubprocessCLITransport` in `src/claude_agent_sdk/_internal/transport/subprocess_cli.py` spawns the CLI
- `_cli_version.py` bundles CLI version `2.1.45` — the same Node.js binary
- The `Transport` abstract class exposes `connect()`, `write()`, `read_messages()`, `close()` — all stdin/stdout IPC
- Communication uses JSON-lines over the subprocess stdio

### TypeScript SDK Architecture

```
Node/Bun process → query() → claude (Node.js CLI) → Anthropic API
```

**Both SDKs spawn the exact same Node.js CLI binary.** The only difference is the host process language.

### Implications for Buildd

Since both SDKs require Node.js at runtime (for the CLI subprocess), the Python SDK does not eliminate the Node.js dependency. A Python worker would need:
1. Python 3.10+ runtime
2. Node.js runtime (for the Claude Code CLI)
3. npm packages (for the CLI binary bundled by the SDK)

This doubles the runtime requirements compared to the current TypeScript-only approach.

---

## 2. Feature Parity Gaps

The Python SDK (v0.1.37) lags behind the TypeScript SDK (v0.2.45) in several areas critical to Buildd workers:

### Missing Features in Python SDK

| Feature | TS SDK (v0.2.45) | Python SDK (v0.1.37) | Buildd Impact |
|---------|-------------------|----------------------|---------------|
| `sessionId` option | Yes | No | Cannot correlate SDK sessions with worker IDs |
| `AbortController` / signal | Yes | No | Cannot cancel workers gracefully |
| V2 Session API | Yes (`unstable_v2_*`) | No | N/A (Buildd uses V1 `query()`) |
| `reconnectMcpServer()` | Yes | No | Cannot recover MCP server failures |
| `toggleMcpServer()` | Yes | No | Cannot disable noisy MCP servers at runtime |
| `setMcpServers()` | Yes | No | Cannot replace MCP servers dynamically |
| `stopTask()` | Yes | No | Cannot stop background subagent tasks |
| `debug` / `debugFile` | Yes | No | No SDK-level debug logging |
| `SessionStart` hook | Yes | No | Cannot inject context at session start |
| `SessionEnd` hook | Yes | No | Cannot track session lifecycle |
| `Notification` hook | Yes | No | Cannot capture agent status messages |
| `TeammateIdle` hook | Yes (experimental) | No | Cannot track agent team coordination |
| `TaskCompleted` hook | Yes (experimental) | No | Cannot track subagent task completion via hooks |
| `resumeSessionAt` | Yes | No | Cannot resume at specific message |
| `strictMcpConfig` | Yes | No | No strict MCP validation |
| `accountInfo()` | Yes | No | Cannot query account info |
| `supportedCommands()` | Yes | No | Cannot list available slash commands |
| `supportedModels()` | Yes | No | Cannot discover available models |
| `AsyncHookJSONOutput` | Yes | No | Hooks always block the agent loop |

### Features Present in Both SDKs

| Feature | Notes |
|---------|-------|
| `query()` async iteration | Core API — functionally equivalent |
| `ClaudeSDKClient` (Python) / streaming mode (TS) | Multi-turn conversations |
| `PreToolUse` / `PostToolUse` hooks | Core hook events work |
| `PostToolUseFailure` hook | Works in both |
| `UserPromptSubmit` hook | Works in both |
| `PreCompact` hook | Works in both |
| `SubagentStart` / `SubagentStop` hooks | Documented in Python |
| `Stop` hook | Works in both |
| MCP servers (stdio, SSE, HTTP) | External MCP transport |
| In-process MCP servers (`create_sdk_mcp_server`) | Custom MCP tools |
| `permissionMode` | All modes supported |
| `canUseTool` callback | Permission callbacks |
| Structured outputs (`outputFormat`) | JSON schema validation |
| File checkpointing | `rewind_files()` |
| Sandbox configuration | Command execution sandboxing |
| Plugins | Local plugin loading |
| Agent definitions (subagents) | `AgentDefinition` dataclass |
| `settingSources` | Control filesystem config loading |
| `systemPrompt` presets | `claude_code` preset available |
| `maxBudgetUsd` / `maxTurns` | Execution limits |
| `betas` | 1M context window opt-in |
| `resume` / `forkSession` | Session continuity |

### Critical Gap: Missing `sessionId`

Buildd uses `sessionId: this.workerId` to correlate SDK sessions with worker records. The Python SDK has no `sessionId` option in `ClaudeAgentOptions`, meaning there's no way to set a custom session ID for tracking purposes.

### Critical Gap: Missing `AbortController`

Buildd workers use `AbortController` to cancel running queries when a task is paused or stopped. The Python SDK's `ClaudeSDKClient` supports `interrupt()`, but `query()` (the simpler API) has no cancellation mechanism. The `ClaudeSDKClient` approach would require restructuring the worker-runner pattern.

### Critical Gap: Missing Hook Events

Buildd's `worker-runner.ts` uses 12 hook events (lines 129–144). Python lacks 4 of these:
- `SessionStart` — used to log session lifecycle
- `SessionEnd` — used to log session lifecycle
- `Notification` — used to capture agent status messages
- `TeammateIdle` / `TaskCompleted` — experimental, used for agent team coordination

The Python SDK docs explicitly state: "SessionStart, SessionEnd, and Notification hooks are NOT supported due to setup limitations."

---

## 3. Startup Time Analysis

### Does Python Reduce Startup Time?

**No.** Startup time is dominated by the CLI subprocess, not the host SDK:

1. **CLI subprocess spawn**: ~2-5s (Node.js process + Claude Code initialization)
2. **SDK initialization**: ~50-100ms (negligible in both languages)
3. **First API call latency**: ~1-3s (Anthropic API, identical for both)

Since the Python SDK spawns the same Node.js CLI binary, the subprocess spawn overhead is identical. Python actually adds a small overhead:
- Python interpreter startup: ~100-200ms
- `anyio` async runtime initialization: ~50ms
- Subprocess communication layer: Python→Node.js IPC vs Node.js→Node.js IPC

For Buildd workers (tasks running 30s–30min), this marginal overhead is negligible. But it certainly doesn't reduce startup time.

### Could a Direct-API Python Client Be Faster?

Hypothetically, a Python SDK that called the Anthropic API directly (without the CLI) could eliminate the CLI subprocess overhead. But this SDK does not do that — it's a CLI wrapper. Building a direct-API integration would be a separate project, unrelated to this SDK evaluation.

---

## 4. Deployment Implications

### Current Deployment (TypeScript-only)

```
Worker environment: Node.js 20+ (or Bun)
Dependencies: @anthropic-ai/claude-agent-sdk, project packages
Runtime: Single language, single package manager
```

### Hypothetical Python Worker Deployment

```
Worker environment: Python 3.10+ AND Node.js 20+
Dependencies: claude-agent-sdk (pip), Claude Code CLI (npm/bundled)
Runtime: Two languages, two package managers, two dependency trees
Build system: pip + npm, or uv + npm, alongside existing Turborepo
```

### Problems

1. **Doubled runtime requirements**: Every worker node needs both Python and Node.js
2. **Docker image bloat**: Adding Python to Node.js images, or vice versa
3. **Dependency management**: Two lock files, two vulnerability surfaces
4. **CI/CD complexity**: Tests need both runtimes, builds need both toolchains
5. **Monorepo friction**: Buildd is a Turborepo TypeScript monorepo — Python packages don't participate in Turborepo's caching, dependency graph, or task pipeline
6. **Type sharing**: Buildd shares types via `packages/shared` — Python workers would need a separate type definition or manual sync
7. **Team expertise**: Adding Python means maintaining two language ecosystems

### For Teams Without Node.js

The task asked whether Python SDK could help teams without Node.js. Since the SDK bundles the CLI binary (requiring Node.js at runtime), it doesn't eliminate the Node.js dependency — it only hides it. Teams without Node.js would still need Node.js installed.

---

## 5. Impact on MCP Server Integration

### Current MCP Integration (TypeScript)

Buildd uses two MCP patterns:

1. **In-process MCP server** (`worker-runner.ts`): `createSdkMcpServer()` creates an MCP server that runs in the same Node.js process as the SDK, using `createBuilddMcpServer()` from `buildd-mcp-server.ts`. Zero subprocess overhead.

2. **HTTP MCP server** (`runner/workers.ts`): Connects to the remote HTTP MCP endpoint at `/api/mcp` via `mcpServers: { buildd: { type: 'http', url: '...', headers: {...} } }`.

### Python MCP Implications

The Python SDK supports:
- External MCP servers (stdio, SSE, HTTP) — equivalent to pattern 2
- In-process MCP servers via `create_sdk_mcp_server()` + `@tool` decorator — conceptually equivalent to pattern 1

However, in practice:
- **Buildd's MCP tools** (`buildd-mcp-server.ts`) are TypeScript. Using them from Python would require either (a) rewriting them in Python, or (b) running them as a subprocess (stdio transport), adding latency.
- **`zod` schemas** used in TS MCP tool definitions would need equivalent Python schemas (e.g., Pydantic models).
- **Shared database access** (`packages/core/db/`) is TypeScript/Drizzle — Python workers couldn't share database code.

---

## 6. Package Metadata

| Property | Value |
|----------|-------|
| Package name | `claude-agent-sdk` |
| Version | 0.1.37 |
| Status | **Alpha** |
| License | MIT |
| Python versions | 3.10, 3.11, 3.12, 3.13 |
| Runtime deps | `anyio>=4.0.0`, `mcp>=0.1.0`, `typing-extensions>=4.0.0` (py<3.11) |
| Bundled CLI | v2.1.45 (same as TS SDK v0.2.45) |
| Platform wheels | macOS ARM64, Linux aarch64/x86_64, Windows amd64 |
| Author | Anthropic, PBC |

---

## 7. Recommendation

### Do Not Adopt for Buildd Workers

| Factor | Assessment |
|--------|------------|
| Startup time improvement | **None** — both SDKs spawn the same CLI subprocess |
| Node.js elimination | **Not possible** — CLI requires Node.js at runtime |
| Feature parity | **Significant gaps** — missing sessionId, AbortController, 4+ hook events |
| Deployment simplicity | **Worse** — adds Python runtime to existing Node.js requirements |
| MCP integration | **More complex** — would require rewriting or subprocess-wrapping TS tools |
| Monorepo fit | **Poor** — TypeScript monorepo, shared types, shared DB code |
| SDK maturity | **Alpha** — v0.1.37, API may change |

### When Python SDK Might Make Sense

The Python SDK is a reasonable choice for:
1. **Pure Python teams** building new agents that don't need Buildd's TypeScript infrastructure
2. **Data science workflows** where Python is the primary language and agents integrate with pandas/numpy/sklearn pipelines
3. **Existing Python applications** that want to add Claude agent capabilities
4. **Prototyping** when developers are more comfortable with Python

None of these apply to Buildd's current architecture or user base.

### What Would Change This Recommendation

1. **Direct API client**: If the Python SDK eliminated the CLI subprocess and called the API directly, it could offer genuine startup time benefits and deployment simplification.
2. **Feature parity**: If Python SDK reached v0.2.x with `sessionId`, `AbortController` equivalent, full hook support, and dynamic MCP management.
3. **Polyglot worker architecture**: If Buildd moved to a language-agnostic worker protocol (e.g., gRPC) where workers could be written in any language.
