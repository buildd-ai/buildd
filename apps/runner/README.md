# buildd runner

The standalone worker that claims and executes buildd tasks. Install with:

```bash
curl -fsSL https://buildd.dev/install.sh | bash
```

(Windows: `irm buildd.dev/install.ps1 | iex`.) This installs Bun, a sparse
clone of this repo under `~/.buildd`, headless Chromium, and the `buildd`
launcher at `~/.local/bin/buildd`.

Running `buildd` on its own starts the runner in the foreground: a
restart-on-update loop that re-execs itself whenever the self-updater applies
a new version (exit code 75), and otherwise keeps running until you close the
terminal. See `docs/testing.md` and `docs/specs/runner-liveness.md` for the
update/heartbeat contract.

## Running as a service

`buildd` on its own is foreground-only — closing the terminal (or logging
out, or rebooting) stops it. `buildd service` registers the same launcher
loop as a per-user background service that starts at login and survives
reboots, without ever running as root:

```bash
buildd service install     # register + start
buildd service status      # is it running?
buildd service logs         # tail stdout/stderr
buildd service uninstall   # remove it
```

The installer offers this at the end automatically — answer the prompt, or
install non-interactively with `--service`:

```bash
curl -fsSL https://buildd.dev/install.sh | bash -s -- --service
```

What `service install` does, per platform:

| Platform | Mechanism | Files |
|---|---|---|
| macOS | a `launchd` LaunchAgent (`RunAtLoad` + `KeepAlive`) | `~/Library/LaunchAgents/dev.buildd.runner.plist` |
| Linux | a `systemd --user` unit (`Restart=always`) | `~/.config/systemd/user/buildd-runner.service` |
| Windows | a Scheduled Task (`AtLogOn` trigger, restart-on-crash settings) | registered task `buildd runner` |

Logs land in `~/.buildd/logs/stdout.log` and `~/.buildd/logs/stderr.log` (or
under `$BUILDD_HOME/logs` if you've overridden `BUILDD_HOME`).

**Linux only:** a `systemd --user` service normally stops when you log out.
To keep it running across reboots even before you log back in:

```bash
loginctl enable-linger $USER
```

`buildd service install` prints this reminder; `buildd service status` warns
if linger isn't enabled yet.

On Windows, the Scheduled Task is registered by `install.ps1` directly (there
is no `buildd service` subcommand on Windows — the launcher there,
`buildd.cmd`, has no subcommand dispatch). Pass `-Service` to register it
non-interactively:

```powershell
&([ScriptBlock]::Create((irm buildd.dev/install.ps1))) -Service
```

Manage or remove it with the standard `ScheduledTasks` PowerShell module:

```powershell
Get-ScheduledTask -TaskName 'buildd runner' | Unregister-ScheduledTask -Confirm:$false
```

Either way, the service always runs **as the installing user** — never
root/Administrator/SYSTEM — and it keeps the exact same self-update behavior
as the foreground loop: an update still exits 75, and the service supervisor
(not the launcher's own `while` loop) brings it back up for anything else,
e.g. a real crash.

## CLI reference

| Command | Purpose |
|---|---|
| `buildd` | Run the worker in the foreground |
| `buildd login` / `buildd logout` | Authenticate / clear the saved API key |
| `buildd status` | Show login status |
| `buildd service install\|uninstall\|status\|logs` | Manage the background service (macOS/Linux) |
| `buildd init <workspace-id>` | Write a per-repo `.mcp.json` for Claude Code |
| `buildd install --global` | Register the buildd MCP server in `~/.claude.json` |

## Agent identity on buildd

The runner authenticates its own calls (claim, worker updates, heartbeat) with
its API key. The agent session it starts calls buildd with its own credential:
at every session start (fresh, resume, follow-up) the runner mints a per-task
token (`bldt_…`, `POST /api/runner/task-token`, 12h) and the agent's buildd
MCP server (Claude `mcpServers.buildd`, Codex `BUILDD_MCP_BEARER_TOKEN`) uses
that, so each call the agent makes carries its own run's identity. Task tokens
are worker level: a runner on an admin key no longer gives its agents
admin-only buildd actions.

Orchestration sessions are the exception and keep the runner key: tasks with
the `organizer` role, `planning` mode, or a heartbeat check-in
(`context.heartbeat`). They need admin-level actions (`manage_missions`,
`approve_plan`, ...). The runner logs one `[agent-task-token] …
reason=orchestration-role` line for them.

If the mint fails (old server, key without the runner scopes, no signing
secret on the server, network) the session starts anyway on the runner key and
the runner logs one `[agent-task-token]` warning with the reason.

| Variable | Default | Effect |
|---|---|---|
| `BUILDD_AGENT_TASK_TOKEN` | on | `0` keeps the old behaviour: the agent's buildd MCP uses the runner key and no token is minted. |
