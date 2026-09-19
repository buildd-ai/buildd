---
status: partially
# Structural conformance only; passing does not certify every prose invariant.
assertions:
  - id: "isolated-workspace-root"
    type: "symbol"
    name: "isolatedWorkspacePath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped Tier 3 isolation; kept suppressed alongside isolated-claude-home and isolated-codex-home because Tier 4 (separate UID/container per tenant) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
  - id: "isolated-claude-home"
    type: "symbol"
    name: "isolatedClaudeConfigDirPath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Shipped Tier 3 isolation; kept suppressed alongside isolated-workspace-root and isolated-codex-home because Tier 4 (separate UID/container per tenant) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
  - id: "isolated-codex-home"
    type: "symbol"
    name: "stableCodexHomeIsolatedPath"
    path: "apps/runner/src/isolation-paths.ts"
    skip_until: "2026-12-15"
    skip_reason: "Assertions here only cover shipped Tier 1 (API key removal) and Tier 3 (per-workspace clones) isolation; Tier 4 (separate UID/container per tenant, closing the /proc/self/environ and world-readable-path read boundary) remains unbuilt and unasserted, so status is intentionally held at 'partially' rather than promoted."
---
# Runner Workspace Isolation

**Status:** Partially Implemented — Tier 1 Option A + a hook-level Tier 2 stopgap + Tier 3 Option B shipped (2026-07-21)
**Related:** `apps/runner/src/workers.ts`, `apps/runner/src/codex-auth.ts`, `apps/runner/src/claude-auth.ts`, `apps/runner/src/isolation-paths.ts`, `apps/runner/src/workspace.ts`, `apps/runner/src/hook-factory.ts`, `apps/runner/src/read-jail.ts`, `apps/runner/src/git-operations.ts`, `apps/runner/src/history-store.ts`, `packages/core/mcp-tools.ts`, `packages/shared/src/types.ts`

## What Has Shipped

### Tier 1 Option A — BUILDD_API_KEY removed from agent subprocess env

`BUILDD_API_KEY` is **no longer injected** into `cleanEnv` in `workers.ts`. Agent Bash tool calls cannot read the runner's coordination key. The buildd MCP server receives its bearer token via `queryOptions.mcpServers.buildd.headers`, not through the subprocess environment.

**Operator migration note:** Any `.mcp.json` that previously referenced `${BUILDD_API_KEY}` must switch to per-workspace `mcpSecrets` (delivered at claim time and injected as `${VAR}` env refs). `BUILDD_MCP_BEARER_TOKEN` is **kept** for Codex tasks because `config.toml` uses `bearer_token_env_var = "BUILDD_MCP_BEARER_TOKEN"` — the existing test contract rejects an inline `bearer_token`.

### Tier 2 (partial) — hook-level read confinement

Neither of the Tier 2 options this doc originally proposed (Landlock, bwrap read-jail) has
shipped — both remain kernel-level future work. What has shipped instead is a narrower,
application-level stopgap, unconditional for every Claude-backend task (no per-workspace
opt-in, consistent with this doc's own Non-Goals):

- **`apps/runner/src/read-jail.ts`** (`buildReadJailDeniedPrefixes`, `isPathDeniedByReadJail`) +
  `HookFactory.createReadJailHook` (`apps/runner/src/hook-factory.ts`), wired as the first
  `PreToolUse` hook in `workers.ts`. Denies `Read`/`Glob`/`Grep` tool calls that resolve outside
  the worker's own worktree into: sibling worktrees under the same repo clone, `~/.buildd/`,
  `$TMPDIR/buildd-codex-homes/`, and `$TMPDIR/claude-cfg-*/`.
- **`SENSITIVE_READ_PATHS`** (`packages/shared/src/types.ts`) — a second, independent check in
  the permission hook's `Read` handling that blocks `~/.buildd/config.json` and
  `~/.claude/.credentials.json` specifically.
- **`DANGEROUS_CREDENTIAL_READ_PATTERNS`** (`packages/shared/src/types.ts`) — regex patterns in
  the same permission hook's `Bash` handling that block `cat`/`head`/`tail`/`less`/`more`/`bat`
  of those same two files, plus a literal `printenv BUILDD_API_KEY`.

**What this does not cover** — the Reachability Table and Threat Model below are annotated with
the specific rows/paths this narrows, but the underlying gap they describe is otherwise
unchanged:

- **Codex tasks have no `PreToolUse` hooks at all** (`workers.ts`: hook wiring is gated on
  `!isCodexTask`), so none of the above applies to Codex-backend workers.
- **Bash is not confined**, only pattern-matched. `find /tmp/buildd-codex-homes -name auth.json`,
  `ls ../` on a sibling worktree, and a broad `env | grep -E 'API_KEY|OAUTH|BEARER'` are not
  covered by `DANGEROUS_CREDENTIAL_READ_PATTERNS` and succeed exactly as this doc's Threat
  Model attack paths 2, 4, and 5 describe. Only the narrow literal patterns above are blocked.
- This is why Tier 2 in the Proposal section below is still listed as outstanding: Landlock or
  bwrap remain the only routes to closing the Bash gap kernel-side.

### Tier 3 Option B — per-workspace isolated git clones

Setting `BUILDD_WORKSPACE_ISOLATION_ROOT=<path>` activates structural filesystem isolation:

- Each workspace gets its own git clone at `<root>/<workspaceId>/`
- Worktrees for that workspace live under `<root>/<workspaceId>/.buildd-worktrees/`
- `CODEX_HOME` is scoped to `<root>/<workspaceId>/codex/<workerId>/`
- `CLAUDE_CONFIG_DIR` is scoped to `<root>/<workspaceId>/claude/<workerId>/`

Cross-workspace traversal via `git worktree list` or `../sibling` paths becomes structurally impossible rather than just undesirable — you'd need to know another workspace's UUID, and those directories are owned by the same UID, so the path traversal is blocked only by obscurity, not a kernel boundary. Full kernel isolation requires Tier 4 (separate UID per workspace or container-per-tenant — not yet implemented).

**Remaining attack surface:** a prompt-injected agent can still read `/proc/self/environ` (for `BUILDD_MCP_BEARER_TOKEN` and any other injected env vars), the runner's `~/.buildd/config.json`, and any world-readable path. Tier 4 UID isolation would close this.

## Problem

The runner executes tasks from multiple tenant workspaces concurrently under a single OS user, in a single process, on a shared filesystem. The only boundaries that currently exist between concurrent tenant agents are:

- **Codex backend**: a write sandbox (`workspace-write` mode) that restricts filesystem *writes* — reads are unconfined.
- **Claude backend**: a bwrap sandbox that must be explicitly opted in via `gitConfig.sandbox.enabled`, and is also force-disabled on kernels where unprivileged user namespaces are unavailable (`isBwrapSupported()` returns false — the common case in Docker and restricted cloud environments).
- Per-worker credential files at mode `0600`/`0700` — meaningless when every concurrent agent runs as the same UID.

A malicious or prompt-injected agent in tenant A's task can read any file the runner user owns: the runner's own API key, other tenants' credential files, sibling worktrees, session archives, and all of `~/.buildd/`. No kernel-enforced read boundary exists between tenants.

## Current State

### Credential injection (`apps/runner/src/workers.ts`)

This subsection reflects Tier 1 Option A already shipped (see "What Has Shipped" above) —
`cleanEnv` is no longer a filtered copy of `process.env`. It is built from an explicit
`RUNNER_ENV_PASSTHROUGH` allowlist (~30 non-secret names: shell/locale/git-identity/proxy
basics, plus `ANTHROPIC_*`/`OPENAI_API_KEY`/`GITHUB_TOKEN`/`GH_TOKEN`, lines 2075–2106), then
layers in per-task credentials:

| Approx. line | Value injected into `cleanEnv` |
|---|---|
| 2158–2172 | `ANTHROPIC_API_KEY` — LLM-provider override, or tenant/server-managed Anthropic key |
| 2181–2192 | `CLAUDE_CODE_OAUTH_TOKEN` — server-managed or tenant OAuth token |
| 2277 | `BUILDD_MCP_BEARER_TOKEN` — the runner's coordination key, **Codex tasks only** (`isCodexTask` block) |

`BUILDD_API_KEY` is **not** in this list — Tier 1 Option A's removal held. It exists only in a
separate `headerExpansionEnv` (line 2206–2210, explicitly documented in-code as "NEVER passed
to the agent subprocess") used solely to resolve `${VAR}` references in `.mcp.json` HTTP
headers before mounting them.

`cleanEnv` is passed to the agent at `queryOptions.env` (line 2953). An agent that can run
`Bash` can still read its own environment and retrieve `ANTHROPIC_API_KEY` /
`CLAUDE_CODE_OAUTH_TOKEN`, and — for Codex tasks — `BUILDD_MCP_BEARER_TOKEN`.

### Sandbox state

**Codex** (`apps/runner/src/backends/codex-backend.ts:350`): `mapSandboxMode()` maps the workspace setting to `'read-only'`, `'workspace-write'`, or (when bwrap user namespaces are unavailable) a `'danger-full-access'` fallback. None of these modes confine filesystem *reads* — there is no read-confinement equivalent to `writable_roots` in the current Codex CLI.

**Claude** (`apps/runner/src/workers.ts:2650–2652`):

```ts
const sandboxConfig = !isBwrapSupported()
  ? { enabled: false }
  : (gitConfig?.sandbox?.enabled ? gitConfig.sandbox : undefined);
```

A sandbox is active only when both conditions hold: (a) the kernel supports unprivileged user namespaces, and (b) the workspace has explicitly opted in. The default for all workspaces is no sandbox.

### Hook write denylist (`apps/runner/src/hook-factory.ts:239–253`)

The `PreToolUse` hook blocks `Write`/`Edit`/`MultiEdit` on paths matching `SENSITIVE_PATHS` (`packages/shared/src/types.ts:1378–1386`): `/etc/`, `/usr/`, `/var/`, `/root/`, `.env`, `.ssh/`, `id_rsa`. This is **write-only** — reads of those same paths are not intercepted, and `~/.buildd/`, CODEX_HOME directories, and sibling worktrees are absent from this list entirely (write or read). A separate, narrower mechanism now covers *reads* of some of those paths — see "What Has Shipped" (Tier 2 partial) above; this write denylist itself is unchanged.

### Disk-resident credential files

**Codex auth.json** (`materializeStableCodexHome` / `ensureStableCodexHome`, `apps/runner/src/codex-auth.ts`): stable per-worker homes live under `$CODEX_HOME_ROOT` (default `$TMPDIR/buildd-codex-homes/<workerId>`, from `codexHomeRoot()`). Directory is `0700`, `auth.json` is `0600`. All owned by the runner user.

**Claude credentials** (`materializeClaudeConfigDir`, `apps/runner/src/claude-auth.ts`): per-worker temp dirs created via `mkdtempSync(tmpdir(), 'claude-cfg-')`, mode `0700`/`0600`. Also owned by the runner user.

Because all concurrent agents share the runner UID, mode bits provide no protection: `cat $TMPDIR/buildd-codex-homes/<other-worker-id>/auth.json` succeeds unconditionally.

### Shared `~/.buildd/` directory

`apps/runner/src/index.ts:23–25` and `apps/runner/src/login.ts:9`: `~/.buildd/config.json` holds the runner's `apiKey`. Worker state is persisted under `~/.buildd/workers/<workerId>.json` (`apps/runner/src/worker-store.ts:20`). Repo checkout cache lives at `~/.buildd/repos-cache.json`. All files are owned by the runner user and readable by any agent running as that user.

### Sibling worktrees (`apps/runner/src/git-operations.ts:243–244`)

All worktrees for a given repository live under `<repoPath>/.buildd-worktrees/<safeBranch>`. An agent working in one branch can reach any sibling worktree via `../other-branch/` — a simple path traversal with no gate.

### What `dataClass=sensitive` actually gates

Sensitive-workspace handling targets *egress and persistence*, not local reads:

- **Process-level output redaction** (`workers.ts:1865`): `activateRedaction()` filters agent output before it leaves the process.
- **Structured-only session archive** (`history-store.ts:231–237`): messages, toolCalls, and output are dropped from the archive for sensitive workspaces; milestones and resultMeta are retained.
- **Memory tool block** (`packages/core/mcp-tools.ts:5137` — `isSensitive` field on `MemoryActionCtx`): `recall`/`learn` return errors for sensitive workspaces.

None of these controls prevent a sensitive-workspace agent from reading standard-workspace files, or prevent a standard-workspace agent from reading sensitive-workspace files.

## Reachability Table

This table describes the original, pre-remediation baseline. The "What Has Shipped" section
above narrows several rows below for Claude-backend tasks: the `Read`/`Glob`/`Grep` tool path
is now denied for the rows marked (†), but the same file is still reachable via `Bash` unless
also marked (‡) — and Codex tasks get neither, since Codex has no `PreToolUse` hooks at all.

| Resource | Path | Reachable by same-UID agent? | What (if anything) blocks it |
|---|---|---|---|
| Runner API key | `~/.buildd/config.json` (`apiKey`) | **Yes**, via `Bash` (e.g. `python`/`node` reading the file) | (†) `Read` tool: `SENSITIVE_READ_PATHS`. (‡) `Bash` `cat`/`head`/`tail`/`less`/`more`/`bat`: `DANGEROUS_CREDENTIAL_READ_PATTERNS`. Other Bash reads (e.g. `python -c "open(...).read()"`) are not pattern-matched. |
| Worker state files | `~/.buildd/workers/*.json` | **Yes** | (†) `Read`/`Glob`/`Grep`: read-jail (whole `~/.buildd/` prefix). `Bash` reads not blocked. |
| Repos checkout cache | `~/.buildd/repos-cache.json` | **Yes** | (†) `Read`/`Glob`/`Grep`: read-jail. `Bash` reads not blocked. |
| Current session credentials | Agent's own `cleanEnv` (in-process env) — `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and (Codex only) `BUILDD_MCP_BEARER_TOKEN`; `BUILDD_API_KEY` itself is no longer injected here (Tier 1 Option A) | **Yes** (via `env` or `/proc/self/environ`) | Nothing general — a literal `printenv BUILDD_API_KEY` is pattern-matched but moot, since that key isn't present to retrieve. A general `env \| grep -E 'API_KEY\|OAUTH\|BEARER'` is not blocked and still yields the other three. |
| Other tenant's Anthropic key / OAuth | `$TMPDIR/buildd-codex-homes/<other-id>/auth.json` or `$TMPDIR/claude-cfg-*/` | **Yes**, via `Bash` (`find`/`cat`) | (†) `Read`/`Glob`/`Grep`: read-jail. `0700`/`0600` still no effect at same UID; `Bash` `find`/`cat` not pattern-matched. |
| Sibling worktree files | `<repo>/.buildd-worktrees/<other-branch>/` | **Yes**, via `Bash` (`ls ../`, `cat ../other-branch/...`) | (†) `Read`/`Glob`/`Grep`: read-jail. `Bash` traversal not blocked. |
| Session archives | Archive dir, `<other-id>.json.gz` | **Yes** | Nothing (dataClass only strips content before writing; file still exists) |
| `/etc`, `/usr`, etc. | `/etc/passwd`, system config | **Yes** (read) | Hook denylist blocks *writes* only |
| Memory service writes | `recall`/`learn` MCP tools | Blocked for sensitive workspaces | `isSensitive` check in `mcp-tools.ts` — covers only memory tools |

## Threat Model

**Actor:** A prompt-injected or malicious agent running inside one tenant workspace's task.

**Objective:** Read credentials belonging to a different tenant workspace, exfiltrate the runner's coordination API key, or read another tenant's source code and commit history.

**Representative attack paths:** (all four described here are for a Claude-backend task; Codex
tasks have no `PreToolUse` hooks at all, so none of the shipped mitigations below apply to them)

1. **Runner API key via `~/.buildd/config.json`** — `cat ~/.buildd/config.json` retrieves `apiKey`, a runner-level coordination key that can claim tasks, update worker state, and read task data across all workspaces on this runner. **Now blocked** for the `Read` tool (`SENSITIVE_READ_PATHS`) and for this literal `cat`/`head`/`tail`/`less`/`more`/`bat` form via `Bash` (`DANGEROUS_CREDENTIAL_READ_PATTERNS`) — but an agent reading the file through any other Bash mechanism (`python`, `node`, `awk`, a pipe the regex doesn't match) is not caught.

2. **Cross-tenant credential scan** — `find /tmp/buildd-codex-homes -name 'auth.json'` lists every live Codex worker's credential file. Reading any of them yields another tenant's OpenAI OAuth tokens or API key. The `0600` mode does not help because all workers run as the same UID. **Blocked for the `Read`/`Glob`/`Grep` tools** (read-jail denies the `$TMPDIR/buildd-codex-homes/` prefix) — **still open via `Bash`**, since `find`/`cat` are not in `DANGEROUS_CREDENTIAL_READ_PATTERNS`.

3. **Claude config scan** — same pattern for `find /tmp -maxdepth 1 -name 'claude-cfg-*'`. Same split: blocked for `Read`/`Glob`/`Grep` (read-jail matches the `claude-cfg-` prefix), still open via `Bash`.

4. **Sibling worktree read** — `ls ../` from within one worktree lists all other branches (and thus other tenants' checked-out source if they share the same repo clone). Relative path traversal. **Blocked for `Read`/`Glob`/`Grep`** (read-jail denies the `.buildd-worktrees/` prefix) — **still open via `Bash`** (`ls`, `cat`, no gate).

5. **In-process environment** — `env | grep -E 'API_KEY|OAUTH|BEARER'` in a Bash tool call retrieves every credential injected into `cleanEnv` for the current session. **`BUILDD_API_KEY` is no longer among them** (Tier 1 Option A — see "What Has Shipped"), but `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, and (for Codex tasks) `BUILDD_MCP_BEARER_TOKEN` still are, and none of that is hideable with filesystem permissions — it is the process environment. Still fully open; only a literal `printenv BUILDD_API_KEY` form is pattern-matched, and that credential isn't there to find any more anyway.

**What does not help today:**

- `0600`/`0700` modes — irrelevant at shared UID.
- `SENSITIVE_PATHS` denylist — write-only; reads are not intercepted. (A separate, much narrower `SENSITIVE_READ_PATHS`/`DANGEROUS_CREDENTIAL_READ_PATTERNS` pair does now intercept reads of two specific credential files — see "What Has Shipped" above — but it is not a general read denylist.)
- `dataClass=sensitive` controls — egress/persistence scope only.
- `permissionMode` (`bypassPermissions` / `acceptEdits` at `workers.ts:2546–2547`) — governs how the SDK approves tool calls, not what files are accessible.
- The Tier-2 read-jail hook — covers `Read`/`Glob`/`Grep` only, for Claude-backend tasks only; general-purpose `Bash` reads bypass it entirely.

## Proposal

Three tiers of increasing isolation. Tiers are independent and can ship separately; Tier 1 is the minimum viable fix.

### Tier 1: Remove the runner API key from agent read-reach (Option A shipped)

**Crux:** `BUILDD_API_KEY` in `cleanEnv` gives every agent the runner's own coordination privileges. The agent needs to *call* the buildd MCP server — it does not need the raw key. The MCP server `Authorization` header in `queryOptions.mcpServers.buildd` already carries the bearer token directly (`workers.ts:3000–3005`), so injecting the key into the subprocess environment is redundant and dangerous.

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

**Option D — hook-level denylist (shipped as a stopgap, see "What Has Shipped" above):** a `PreToolUse` hook (`apps/runner/src/read-jail.ts` + `hook-factory.ts`) denies `Read`/`Glob`/`Grep` calls outside the worktree, plus two regex-matched `Bash` credential-read patterns. This is real, unconditional protection for the Claude SDK's own file-access tools, but it is not the kernel-level confinement this section calls for — `Bash` reads via anything other than the specific matched patterns still pass through untouched, and Codex tasks (no `PreToolUse` hooks) get none of it. Options A/B/C below remain the way to close that gap.

**Option A — Linux Landlock:**

Use the Landlock LSM (`landlock_restrict_self` with `LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR` rules anchored to the worktree path). Landlock requires Linux ≥ 5.13 and does **not** require unprivileged user namespaces, so it works in Docker and other environments where bwrap fails. Implementation: a small Bun native addon or child-process helper that applies Landlock rules and then `exec`s the agent binary.

**Option B — bwrap read-jail (separate from the existing opt-in sandbox):**

When `isBwrapSupported()` returns true, launch the agent inside a bwrap namespace that bind-mounts only the worktree read-write and presents the rest of the filesystem as empty or read-only. This is a *new*, always-on read-jail — distinct from the existing `gitConfig.sandbox` opt-in (which controls Claude tool permissions, not filesystem visibility). The Tier 2 read-jail subsumes the existing sandbox benefit; the `gitConfig.sandbox` opt-in can be deprecated once Tier 2 ships.

> **Do NOT fix the bwrap namespace failure by disabling the sandbox.** When `isBwrapSupported()` returns false (Docker, some cloud VMs), the correct response is to apply Landlock (Option A) or escalate to Tier 3, not to fall back to no confinement.

**Option C — Codex `writable_roots` read confinement:**

Investigate whether the deployed Codex CLI version supports a read-only root with `writable_roots = [worktree]` that also restricts reads outside the listed paths. The current `mapSandboxMode()` at `codex-backend.ts:350` returns `'read-only'`, `'workspace-write'`, or a `'danger-full-access'` fallback, with no read-confinement mechanism visible in any of them. Needs a spike against the live Codex CLI before committing.

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

1. **Tier 1 / Option A (stop injecting runner API key into `cleanEnv`)** — **Shipped.** Verified: a Bash call `env | grep BUILDD_API_KEY` inside an agent session returns empty.

2. **Tier 2 / Option A (Landlock)** — implement a Landlock helper that applies read rules before exec-ing the agent. Gate on a kernel-version check at startup; log a warning (not a hard error) when unavailable. Landlock v1 (kernel ≥ 5.13) covers Ubuntu 22.04+, Debian 12+, and most current LTS distributions.

3. **Tier 2 / Option B (bwrap read-jail)** — add as the preferred mechanism on hosts where user namespaces are available. At this point the existing `gitConfig.sandbox` opt-in becomes redundant; deprecate it with a release note.

4. **Tier 1 / Option B (separate runner UID)** — deploy alongside a systemd/Docker `USER` config change for self-hosted runners. Document the migration.

5. **Tier 3 / Option A or B** — scope based on deployment model. Single-operator self-hosted runners can defer indefinitely; multi-tenant platform deployments should target Tier 3 before opening to untrusted workloads.

## Open Questions

1. **Landlock kernel floor:** What is the minimum kernel version the runner must support? Landlock v1 (5.13) covers common LTS distributions but not all. Lean toward requiring it and emitting a clear startup warning when unavailable, rather than silently skipping confinement.

2. **MCP header visibility:** Now that `BUILDD_API_KEY` has been removed from `cleanEnv` (Tier 1 / Option A, shipped), can an agent still read the bearer token from the Claude Code SDK's in-memory MCP server configuration (e.g. via a `read_resource` call)? Still needs investigation against the SDK version in use — unresolved by the read-jail hook, which only gates the filesystem.

3. **Codex `writable_roots` read confinement:** Not yet verified against the deployed CLI version. A short spike is required before committing to Tier 2 / Option C as an alternative to Landlock/bwrap.

4. **Serverless runners:** Tier 1 / Option B (separate runner UID) is not applicable to ephemeral serverless worker environments where OS user management is unavailable. Option A covers serverless; confirm that injecting no runner key does not break any serverless-specific flow.

## Non-Goals

- **Changing the `dataClass=sensitive` egress and persistence controls** — those address a different threat surface (data leaving the system after the fact) and are not in scope here.
- **Network egress confinement** — out of scope; see the separate egress-redaction recon.
- **Making the read-jail opt-in per workspace** — the Tier 2 read-jail must be unconditional. A per-workspace toggle would allow a compromised workspace to disable confinement for itself.
- **Fixing the bwrap namespace failure by disabling the sandbox** — the correct response to `isBwrapSupported() === false` is Landlock or Tier 3, not removing confinement entirely.
- **Retroactive isolation of completed session archives** — archives already written are not retroactively restricted; the fix applies to sessions started after the change.
