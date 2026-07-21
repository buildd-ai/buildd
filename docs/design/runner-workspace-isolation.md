# Runner Workspace Isolation

**Status:** Proposed
**Related:** `apps/runner/src/workers.ts`, `apps/runner/src/codex-auth.ts`, `apps/runner/src/claude-auth.ts`, `apps/runner/src/hook-factory.ts`, `apps/runner/src/git-operations.ts`, `apps/runner/src/history-store.ts`, `packages/core/mcp-tools.ts`, `packages/shared/src/types.ts`

## Problem

The runner executes tasks from multiple tenant workspaces concurrently under a single OS user, in a single process, on a shared filesystem. The only boundaries that currently exist between concurrent tenant agents are:

- **Codex backend**: a write sandbox (`workspace-write` mode) that restricts filesystem *writes* — reads are unconfined.
- **Claude backend**: a bwrap sandbox that must be explicitly opted in via `gitConfig.sandbox.enabled`, and is also force-disabled on kernels where unprivileged user namespaces are unavailable (`isBwrapSupported()` returns false — the common case in Docker and restricted cloud environments).
- Per-worker credential files at mode `0600`/`0700` — meaningless when every concurrent agent runs as the same UID.

A malicious or prompt-injected agent in tenant A's task can read any file the runner user owns: the runner's own API key, other tenants' credential files, sibling worktrees, session archives, and all of `~/.buildd/`. No kernel-enforced read boundary exists between tenants.

## Current State

### Credential injection (`apps/runner/src/workers.ts`)

Session startup filters `process.env` into `cleanEnv` at line 1533–1537 (expired OAuth tokens are stripped), then layers in per-task credentials:

| Approx. line | Value injected into `cleanEnv` |
|---|---|
| 1568–1570 | `ANTHROPIC_API_KEY` — tenant or server-managed Anthropic key |
| 1577–1580 | `CLAUDE_CODE_OAUTH_TOKEN` — server-managed or tenant OAuth token |
| 1599–1601 | `BUILDD_API_KEY` — **the runner's own coordination key** |
| 1671 | `BUILDD_MCP_BEARER_TOKEN` — same runner key, for Codex MCP config |

`cleanEnv` is passed verbatim to the agent at `queryOptions.env` (line 1976). An agent that can run `Bash` can read its own environment and retrieve all four values above.

### Sandbox state

**Codex** (`apps/runner/src/backends/codex-backend.ts:336`): `mapSandboxMode()` maps the workspace setting to `'read-only'` or `'workspace-write'`. Neither mode confines filesystem *reads* — there is no read-confinement equivalent to `writable_roots` in the current Codex CLI.

**Claude** (`apps/runner/src/workers.ts:1934–1936`):

```ts
const sandboxConfig = !isBwrapSupported()
  ? { enabled: false }
  : (gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined);
```

A sandbox is active only when both conditions hold: (a) the kernel supports unprivileged user namespaces, and (b) the workspace has explicitly opted in. The default for all workspaces is no sandbox.

### Hook write denylist (`apps/runner/src/hook-factory.ts:114–129`)

The `PreToolUse` hook blocks `Write`/`Edit`/`MultiEdit` on paths matching `SENSITIVE_PATHS` (`packages/shared/src/types.ts:1001–1008`): `/etc/`, `/usr/`, `/var/`, `/root/`, `.env`, `.ssh/`, `id_rsa`. This is **write-only** — reads of those same paths are not intercepted. Notably absent from the denylist: `~/.buildd/`, CODEX\_HOME directories, and sibling worktrees.

### Disk-resident credential files

**Codex auth.json** (`apps/runner/src/codex-auth.ts:29–30`): stable per-worker homes live under `$CODEX_HOME_ROOT` (default `$TMPDIR/buildd-codex-homes/<workerId>`). Directory is `0700`, `auth.json` is `0600`. All owned by the runner user.

**Claude credentials** (`apps/runner/src/claude-auth.ts:25–38`): per-worker temp dirs created via `mkdtempSync(tmpdir(), 'claude-cfg-')`, mode `0700`/`0600`. Also owned by the runner user.

Because all concurrent agents share the runner UID, mode bits provide no protection: `cat $TMPDIR/buildd-codex-homes/<other-worker-id>/auth.json` succeeds unconditionally.

### Shared `~/.buildd/` directory

`apps/runner/src/index.ts:14–15` and `apps/runner/src/login.ts:9`: `~/.buildd/config.json` holds the runner's `apiKey`. Worker state is persisted under `~/.buildd/workers/<workerId>.json` (`apps/runner/src/worker-store.ts:20`). Repo checkout cache lives at `~/.buildd/repos-cache.json`. All files are owned by the runner user and readable by any agent running as that user.

### Sibling worktrees (`apps/runner/src/git-operations.ts:79–81`)

All worktrees for a given repository live under `<repoPath>/.buildd-worktrees/<safeBranch>`. An agent working in one branch can reach any sibling worktree via `../other-branch/` — a simple path traversal with no gate.

### What `dataClass=sensitive` actually gates

Sensitive-workspace handling targets *egress and persistence*, not local reads:

- **Process-level output redaction** (`workers.ts:1384–1385`): `activateRedaction()` filters agent output before it leaves the process.
- **Structured-only session archive** (`history-store.ts:231–237`): messages, toolCalls, and output are dropped from the archive for sensitive workspaces; milestones and resultMeta are retained.
- **Memory tool block** (`packages/core/mcp-tools.ts:2799` — `isSensitive` field on `McpContext`): `recall`/`learn` return errors for sensitive workspaces.

None of these controls prevent a sensitive-workspace agent from reading standard-workspace files, or prevent a standard-workspace agent from reading sensitive-workspace files.

## Reachability Table

| Resource | Path | Reachable by same-UID agent? | What (if anything) blocks it |
|---|---|---|---|
| Runner API key | `~/.buildd/config.json` (`apiKey`) | **Yes** | Nothing |
| Worker state files | `~/.buildd/workers/*.json` | **Yes** | Nothing |
| Repos checkout cache | `~/.buildd/repos-cache.json` | **Yes** | Nothing |
| Current session credentials | Agent's own `cleanEnv` (in-process env) | **Yes** (via `env` or `/proc/self/environ`) | Nothing |
| Other tenant's Anthropic key / OAuth | `$TMPDIR/buildd-codex-homes/<other-id>/auth.json` or `$TMPDIR/claude-cfg-*/` | **Yes** | `0700`/`0600` — same UID, no effect |
| Sibling worktree files | `<repo>/.buildd-worktrees/<other-branch>/` | **Yes** | Nothing |
| Session archives | Archive dir, `<other-id>.json.gz` | **Yes** | Nothing (dataClass only strips content before writing; file still exists) |
| `/etc`, `/usr`, etc. | `/etc/passwd`, system config | **Yes** (read) | Hook denylist blocks *writes* only |
| Memory service writes | `recall`/`learn` MCP tools | Blocked for sensitive workspaces | `isSensitive` check in `mcp-tools.ts` — covers only memory tools |

## Threat Model

**Actor:** A prompt-injected or malicious agent running inside one tenant workspace's task.

**Objective:** Read credentials belonging to a different tenant workspace, exfiltrate the runner's coordination API key, or read another tenant's source code and commit history.

**Representative attack paths:**

1. **Runner API key via `~/.buildd/config.json`** — `cat ~/.buildd/config.json` retrieves `apiKey`, a runner-level coordination key that can claim tasks, update worker state, and read task data across all workspaces on this runner. No sandbox or hook blocks this read.

2. **Cross-tenant credential scan** — `find /tmp/buildd-codex-homes -name 'auth.json'` lists every live Codex worker's credential file. Reading any of them yields another tenant's OpenAI OAuth tokens or API key. The `0600` mode does not help because all workers run as the same UID.

3. **Claude config scan** — same pattern for `find /tmp -maxdepth 1 -name 'claude-cfg-*'`.

4. **Sibling worktree read** — `ls ../` from within one worktree lists all other branches (and thus other tenants' checked-out source if they share the same repo clone). Relative path traversal, no gate.

5. **In-process environment** — `env | grep -E 'API_KEY|OAUTH|BEARER'` in a Bash tool call retrieves every credential injected into `cleanEnv` for the current session, including `BUILDD_API_KEY`. Cannot be hidden with filesystem permissions; it is the process environment.

**What does not help today:**

- `0600`/`0700` modes — irrelevant at shared UID.
- `SENSITIVE_PATHS` denylist — write-only; reads are not intercepted.
- `dataClass=sensitive` controls — egress/persistence scope only.
- `permissionMode` (`bypassPermissions` / `acceptEdits` at `workers.ts:1848`) — governs how the SDK approves tool calls, not what files are accessible.

## Proposal

Three tiers of increasing isolation. Tiers are independent and can ship separately; Tier 1 is the minimum viable fix.

### Tier 1: Remove the runner API key from agent read-reach

**Crux:** `BUILDD_API_KEY` in `cleanEnv` gives every agent the runner's own coordination privileges. The agent needs to *call* the buildd MCP server — it does not need the raw key. The MCP server `Authorization` header in `queryOptions.mcpServers.buildd` already carries the bearer token directly (`workers.ts` ~2014), so injecting the key into the subprocess environment is redundant and dangerous.

**Option A — Do not inject `BUILDD_API_KEY` / `BUILDD_MCP_BEARER_TOKEN` into `cleanEnv`:**

- Remove `cleanEnv.BUILDD_API_KEY = this.config.apiKey` (~line 1600).
- Remove `cleanEnv.BUILDD_MCP_BEARER_TOKEN = this.config.apiKey` (~line 1671); instead pass the value into `writeCodexMcpConfig()` at call time rather than via the env.
- Verify that no agent-facing `.mcp.json` template references `${BUILDD_API_KEY}` — if it does, route those references through a less-privileged per-task token issued at claim time.

This option touches ~5 lines, requires no OS changes, and applies equally to hosted and self-hosted runners.

**Option B — Run the runner process as a distinct OS user from agent subprocesses:**

Run the runner daemon as `buildd-runner` (owns `~/.buildd/`, credential files, archive dir). Spawn each agent subprocess under a separate unprivileged user (e.g. via a small `setuid` helper or `sudo -u`). `~/.buildd/config.json` is `0700 buildd-runner`, unreadable to the agent user.

This is the stronger fix but requires deployment changes (systemd unit, Docker `USER` directive, `sudo` policy). Suitable for self-hosted runners; not applicable to ephemeral serverless workers.

Tier 1 Option A should ship first (cheap, covers all runner types). Option B adds defense-in-depth for self-hosted deployments.

### Tier 2: Confine agent reads to the worktree (read-jail)

**Crux:** The agent legitimately needs read/write access to its own worktree and a small set of SDK-internal paths. Every other path — sibling worktrees, credential dirs, `~/.buildd/`, `/proc/*/environ` of other processes — should be invisible or inaccessible.

**Option A — Linux Landlock:**

Use the Landlock LSM (`landlock_restrict_self` with `LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR` rules anchored to the worktree path). Landlock requires Linux ≥ 5.13 and does **not** require unprivileged user namespaces, so it works in Docker and other environments where bwrap fails. Implementation: a small Bun native addon or child-process helper that applies Landlock rules and then `exec`s the agent binary.

**Option B — bwrap read-jail (separate from the existing opt-in sandbox):**

When `isBwrapSupported()` returns true, launch the agent inside a bwrap namespace that bind-mounts only the worktree read-write and presents the rest of the filesystem as empty or read-only. This is a *new*, always-on read-jail — distinct from the existing `gitConfig.sandbox` opt-in (which controls Claude tool permissions, not filesystem visibility). The Tier 2 read-jail subsumes the existing sandbox benefit; the `gitConfig.sandbox` opt-in can be deprecated once Tier 2 ships.

> **Do NOT fix the bwrap namespace failure by disabling the sandbox.** When `isBwrapSupported()` returns false (Docker, some cloud VMs), the correct response is to apply Landlock (Option A) or escalate to Tier 3, not to fall back to no confinement.

**Option C — Codex `writable_roots` read confinement:**

Investigate whether the deployed Codex CLI version supports a read-only root with `writable_roots = [worktree]` that also restricts reads outside the listed paths. The current `mapSandboxMode()` at `codex-backend.ts:336` returns only `'read-only'` or `'workspace-write'` with no read-confinement mechanism visible. Needs a spike against the live Codex CLI before committing.

### Tier 3: Structural per-workspace isolation

**Crux:** Tiers 1 and 2 harden a shared-process model. Tier 3 eliminates the sharing.

**Option A — Separate OS user per workspace:**

Create one unprivileged user per workspace (e.g. `buildd-ws-<workspace-id>`). Tasks for that workspace always run as that user. Cross-workspace credential reads fail at the kernel permission check. `CODEX_HOME` and Claude config dirs are owned by the per-workspace user.

**Option B — Separate repository clone per tenant:**

Instead of all tenants sharing one repo clone with sibling worktrees, each tenant workspace receives its own clone. Sibling worktree traversal disappears because no two workspaces share a `<repoPath>/.buildd-worktrees/` parent directory.

**Option C — Container-per-tenant:**

Run each tenant's agent in its own container (Docker, Firecracker microVM) with an independent filesystem namespace. Strongest isolation model; requires the runner host to be able to spawn containers, which conflicts with runners that are themselves containerized. Priority if the platform offers hosted runners at scale.

## Implementation Sketch

Ordered by impact per unit of effort:

1. **Tier 1 / Option A (stop injecting runner API key into `cleanEnv`)** — ~5-line change in `workers.ts`. Ship first. Verifiable: a Bash call `env | grep BUILDD_API_KEY` inside an agent session should return empty after the change.

2. **Tier 2 / Option A (Landlock)** — implement a Landlock helper that applies read rules before exec-ing the agent. Gate on a kernel-version check at startup; log a warning (not a hard error) when unavailable. Landlock v1 (kernel ≥ 5.13) covers Ubuntu 22.04+, Debian 12+, and most current LTS distributions.

3. **Tier 2 / Option B (bwrap read-jail)** — add as the preferred mechanism on hosts where user namespaces are available. At this point the existing `gitConfig.sandbox` opt-in becomes redundant; deprecate it with a release note.

4. **Tier 1 / Option B (separate runner UID)** — deploy alongside a systemd/Docker `USER` config change for self-hosted runners. Document the migration.

5. **Tier 3 / Option A or B** — scope based on deployment model. Single-operator self-hosted runners can defer indefinitely; multi-tenant platform deployments should target Tier 3 before opening to untrusted workloads.

## Open Questions

1. **Landlock kernel floor:** What is the minimum kernel version the runner must support? Landlock v1 (5.13) covers common LTS distributions but not all. Lean toward requiring it and emitting a clear startup warning when unavailable, rather than silently skipping confinement.

2. **MCP header visibility:** After removing `BUILDD_API_KEY` from `cleanEnv` (Tier 1 / Option A), can an agent still read the bearer token from the Claude Code SDK's in-memory MCP server configuration (e.g. via a `read_resource` call)? Needs investigation against the SDK version in use.

3. **Codex `writable_roots` read confinement:** Not yet verified against the deployed CLI version. A short spike is required before committing to Tier 2 / Option C as an alternative to Landlock/bwrap.

4. **Serverless runners:** Tier 1 / Option B (separate runner UID) is not applicable to ephemeral serverless worker environments where OS user management is unavailable. Option A covers serverless; confirm that injecting no runner key does not break any serverless-specific flow.

## Non-Goals

- **Changing the `dataClass=sensitive` egress and persistence controls** — those address a different threat surface (data leaving the system after the fact) and are not in scope here.
- **Network egress confinement** — out of scope; see the separate egress-redaction recon.
- **Making the read-jail opt-in per workspace** — the Tier 2 read-jail must be unconditional. A per-workspace toggle would allow a compromised workspace to disable confinement for itself.
- **Fixing the bwrap namespace failure by disabling the sandbox** — the correct response to `isBwrapSupported() === false` is Landlock or Tier 3, not removing confinement entirely.
- **Retroactive isolation of completed session archives** — archives already written are not retroactively restricted; the fix applies to sessions started after the change.
