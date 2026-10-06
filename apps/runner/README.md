# buildd runner

The standalone worker that claims and executes buildd tasks. Install with:

```bash
curl -fsSL https://buildd.dev/install.sh | bash
exec $SHELL
buildd login        # or: buildd login --device, on a machine with no browser
buildd              # or: buildd service install, to run it in the background
```

(Windows: `irm buildd.dev/install.ps1 | iex`.) This installs Bun, a sparse
clone of this repo under `~/.buildd`, headless Chromium, and the `buildd`
launcher at `~/.local/bin/buildd`.

The runner is headless: it serves no local page unless started with
`buildd --debug` (http://localhost:8766), and without a login it idles, so
`buildd login` comes first. Running `buildd` on its own starts the runner in
the foreground: a
restart-on-update loop that re-execs itself whenever the self-updater applies
a new version (exit code 75), and otherwise keeps running until you close the
terminal. See `docs/testing.md` and `docs/specs/runner-liveness.md` for the
update/heartbeat contract.

## Pointing at another buildd server

The runner and `buildd login` talk to `https://buildd.dev` unless told
otherwise. For a self-hosted server or a local one, log in against it:

```bash
buildd login --server https://buildd.example.com
buildd login --server http://localhost:3000 --device   # no browser on this machine
```

The login saves the server next to the API key in `~/.buildd/config.json`
(`builddServer`), and the runner reads it from there, so `buildd` and
`buildd service install` need no flag afterwards. To check: `buildd status`.

`BUILDD_SERVER` overrides the saved server for the runner process only, which
is handy for a one-off run or a container:

```bash
BUILDD_SERVER=https://buildd.example.com buildd
```

`buildd login` does not read `BUILDD_SERVER`; pass `--server` to it. The API
key belongs to the server that issued it, so after switching servers run
`buildd login --server …` again.

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

## Model login on the runner machine

The runner gives its agents its own machine's Claude login. Two ways to set
one up, both as the user the runner runs as:

- **`claude login`** (interactive). Run it once on the machine. The Claude CLI
  keeps the login under `$HOME` (`~/.claude/.credentials.json` on Linux, the
  login keychain on macOS) and refreshes it itself.
- **`claude setup-token`** (headless). Run it anywhere you can open a browser,
  and put the printed value in the runner's environment as
  `CLAUDE_CODE_OAUTH_TOKEN`. It is a long-lived token with no refresh, so it
  suits servers and containers.

Which seat an agent gets is set by `BUILDD_HOST_SEAT` in the runner's
environment:

| Value | Agent gets |
|---|---|
| unset or `auto` | The machine's login, unless the team also stores a subscription seat in buildd Settings. Then the stored seat is used, exactly as before. |
| `prefer` | The machine's login, even when a seat is stored in buildd. |
| `off` | Never the machine's env token; a stored seat as before. |

Before you switch a runner that uses a stored seat to `prefer`, check the
machine's login with one real session as the runner user, for example
`claude -p 'reply ok'` with the same environment the runner has. A check
against the models endpoint is not enough: it can pass for a token that a
session rejects.

A metered key or endpoint the team configured still applies: a delivered
`ANTHROPIC_API_KEY` fills that variable when the machine has not set it, and a
team agent model endpoint or a non-Anthropic `ANTHROPIC_BASE_URL` replaces the
login (a seat is never sent to a third-party host).

Per setup:

| Where the runner runs | What to do |
|---|---|
| Your own Mac or Linux box, in a terminal | `claude login`, then start `buildd`. Or `export CLAUDE_CODE_OAUTH_TOKEN=...` in the shell that starts it. |
| macOS service (`buildd service install`) | `claude login` as the same user; the LaunchAgent runs as you and sees the keychain login. |
| Linux service (`systemd --user`) | `claude login` as the same user, or put the token in a file only you can read and point the unit at it: `install -m 600 /dev/null ~/.config/buildd/seat.env`, write `CLAUDE_CODE_OAUTH_TOKEN=...` into it, then `systemctl --user edit buildd-runner` and add `[Service]` / `EnvironmentFile=%h/.config/buildd/seat.env`, then `systemctl --user restart buildd-runner`. Add `Environment=BUILDD_HOST_SEAT=prefer` the same way if a seat is also stored in buildd. |
| Coder, Docker or a similar container | Set `CLAUDE_CODE_OAUTH_TOKEN` (and `BUILDD_HOST_SEAT=prefer` if a seat is also stored in buildd) in the container or workspace environment the runner process inherits (a workspace parameter or secret, not a file baked into the image), and restart the runner. |

Check which one a worker used in its log: `Claude seat: this machine's own
login (...)` means the machine's login; `Claude seat: the seat stored in
buildd; ... is present but not used` and `Injected server-managed
CLAUDE_CODE_OAUTH_TOKEN` mean the stored seat. The token value is never
logged, and it is redacted from milestones, error traces and evidence like any
other credential.

### Codex (ChatGPT) login

The same rule covers Codex tasks. Run `codex login` on the runner machine as
the runner's user. The runner finds it in `$CODEX_HOME` if that is set, and in
`~/.codex` otherwise, so no extra environment is needed. Each Codex worker
keeps its own Codex home (config, sessions). Its `auth.json` is a link to your
login, so the CLI's token refreshes land in your file and do not go stale in a
copy. A credential buildd delivers is never written through that link.

`BUILDD_HOST_SEAT` works the same way. Under `auto`, your login is used when
the team stores no Codex credential in buildd. Under `prefer`, it also beats a
stored ChatGPT login. A team OpenAI API key is metered usage the team chose,
so it is still used under every mode. The log line `Codex login: this
machine's own` confirms which login ran.

A ChatGPT login rotates its refresh token on every use. Several Codex workers
refreshing at once can sign each other out. Keep the runner at one concurrent
Codex task per login, or give Codex a team OpenAI API key.

## CLI reference

| Command | Purpose |
|---|---|
| `buildd` | Run the worker in the foreground |
| `buildd login` / `buildd logout` | Authenticate / clear the saved API key (`--server <url>` for a server other than buildd.dev, `--device` without a browser) |
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

## What the agent can and cannot reach on a self-hosted runner

The runner key is a runner credential. On a self-hosted runner the runner keeps
it out of everything it hands an agent session:

- **Environment.** The agent's env is built from an allowlist
  (`src/agent-env.ts`); the runner key is not on it. That holds for Codex too:
  the `codex` CLI gets exactly the task env, not the runner's process env. Role
  env that would resolve to the runner key's value is dropped, with a warning
  naming the variable.
- **buildd MCP.** The agent's own `buildd` server carries its per-task token
  (see above). It shadows any `buildd` entry in the operator's
  `~/.claude.json`, so the operator's own entry never reaches an agent session.
- **`${BUILDD_API_KEY}` in a `.mcp.json`.** It never expands to the runner key.
  For a server on this runner's buildd origin (`builddServer`) it expands to the
  agent's buildd credential, the same one its `buildd` entry carries. A server
  on any other host that asks for it is not mounted, and the runner logs one
  warning naming the server and host. It is never expanded inside a URL. The
  documented use, a role's `buildd` entry with `Bearer ${BUILDD_API_KEY}`, is
  unaffected: that name is reserved and the runner's own entry wins.
- **Connector auth.** Assertion-mode connectors are minted with the runner key
  inside the runner process; the agent's MCP entry carries only the exchanged
  access token.
- **Files.** The agent's file tools are refused under `~/.buildd/` and
  `~/.claude.json`. `buildd login` and `buildd install --global` write
  `~/.claude.json` with mode 0600, like `~/.buildd/config.json`.

What remains:

- Orchestration sessions (organizer, planning, heartbeat check-ins), and any
  session whose task-token mint failed, run their `buildd` MCP on the runner
  key. The MCP config, header included, is passed to the agent's CLI process on
  its command line, which the same OS user can read. For every other session
  that header is the per-task token.
- The agent runs as the same OS user as the runner. The runner's own files
  (`~/.buildd/config.json`, and `~/.claude.json` if you used `buildd login`)
  are readable by that user; the file-tool refusals above do not stop a shell
  command. Process-level isolation is the boundary for that: on Linux, the
  bwrap mount allowlist (`BUILDD_SANDBOX_MOUNT_ALLOWLIST=1`, Claude sessions)
  binds neither file into the agent's namespace; otherwise use a hosted or
  container runner, where the runner key never enters the agent's machine.
