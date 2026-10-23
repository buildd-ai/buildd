# Claude confinement on Windows through WSL2

Run **both buildd and Claude inside the same WSL2 distribution**, as its ordinary
Linux user. Discovering WSL from Windows does not confine a native Windows process.
Native Windows Claude has no built-in sandbox. This workflow supplements the
existing installer/doctor isolation diagnostics; it does not relax task policy.

Checked against [Claude sandbox documentation](https://code.claude.com/docs/en/sandboxing):
Linux/WSL2 use bubblewrap and socat. The sandbox covers shell commands; Claude file
tools, MCP servers and hooks have a different boundary. Do not interpret a passing
probe as whole-machine isolation or a model authentication test.

## Guided setup: `buildd wsl install`

From PowerShell, with the Windows runner installed:

```powershell
buildd wsl install            # or: buildd wsl install --distro <name>
```

It needs Windows 10 build 19041 or later, or Windows 11, and stops on anything
older. It reuses a WSL2 distribution that is already there. With none, it shows
`wsl --install -d Ubuntu --no-launch` and runs it only after you answer yes; a
no (or no terminal) installs nothing. If Windows asks for a restart, restart and
run the same command again. It then opens the distribution so you create your
Linux user, and runs the Linux installer inside it as that user. It never
converts WSL1, creates a Linux user or runs anything as root. The manual steps
below remain the fallback, and `bun run wsl:setup` stays a probe only.

## 1. Probe from PowerShell

From a current buildd source checkout with Windows Bun installed:

```powershell
bun run wsl:setup
bun run wsl:setup --distro Ubuntu
```

This lists distributions and their WSL versions, then checks Linux git, curl, Bun,
bubblewrap, socat, Claude and the default runner installation. It rejects commands
resolved under `/mnt` or ending in `.exe`: Windows tools are not Linux runtimes.
It may start a stopped distribution. It never installs packages, reads credentials,
changes Windows features/firewall settings, or registers/stops services. Exit 0
means prerequisites were found, **not that confinement or authentication passed**.
Exit 1 gives the missing prerequisite or failed probe; 64 means invalid arguments.
An access-denied/timeout result establishes no distribution readiness. Repeat
`wsl --list --verbose` in an unrestricted PowerShell as the same Windows user;
resolve the reported WSL error before continuing. Do not install a second distro
merely because enumeration failed.

If WSL or a distribution is absent, the operator can explicitly run from an
Administrator PowerShell (this changes Windows features and installs Linux):

The supported WSL install command requires Windows 10 build 19041+ or Windows 11.

```powershell
wsl --install -d Ubuntu
```

Reboot if requested, open Ubuntu and create a normal Linux user. For an existing
WSL1 distribution, back up any important data, then explicitly convert it:

```powershell
wsl --set-version Ubuntu 2
wsl --list --verbose
wsl --distribution Ubuntu
```

See [Microsoft WSL installation](https://learn.microsoft.com/windows/wsl/install).
No firewall changes are required by this workflow. Do not expose the runner port
or add broad firewall exceptions to solve a failed probe.

## 2. Install inside Ubuntu/Debian

The following are **operator initiated installation commands**, run in the Linux
shell as the eventual runner user. Other distributions need equivalent packages.

```bash
sudo apt-get update
sudo apt-get install -y git curl unzip bubblewrap socat
curl -fsSL https://bun.sh/install | bash
exec "$SHELL" -l
curl -fsSL https://claude.ai/install.sh | bash
exec "$SHELL" -l
curl -fsSL https://buildd.dev/install.sh | bash
exec "$SHELL" -l
```

Decline the installer's background-service offer until verification is complete.
Do not run these commands as root. Keep the runner under the Linux home directory
(default `~/.buildd`). Clone working repositories under `~/code`, not `/mnt/c`;
use Linux git and configure repository access inside Linux. Configure the runner's
`PROJECTS_ROOT` to that Linux directory if needed. Windows and Linux installations
have separate configuration, login and process ownership. Never copy the Windows
profile, `.claude` or `.buildd` credential directories into Linux.

## 3. Authenticate inside the distribution

```bash
claude login
buildd login --device
buildd status
```

Use the supported browser/device prompts as this Linux user. Model login and
buildd login are separate: a buildd key does not buy or authenticate model usage.
For supported headless model-token or API-key flows see the runner README's model
login section; provide credentials explicitly in the Linux environment, not by
importing the Windows profile. A background service must receive its own intended
environment. Confirm a simple interactive Claude request succeeds before startup.

## 4. Verify confinement before starting work

Run inside Linux, using the **installed runner's Bun and current code**:

```bash
bun ~/.buildd/apps/runner/src/isolation-check.ts --verify-wsl
buildd --doctor
```

The JSON must say `backend: claude`, `verified: true`, platform `linux-wsl`, and
Claude mechanism `bwrap` with write and network scopes. Its probe timestamp must
be at or after its process-start timestamp. This runs the same uncached namespace
probe as installer/doctor/runtime. A nonzero exit, missing record or failed probe
is a stop condition for protected work. A Windows preflight pass cannot substitute
for it. Doctor also reports other backends: a Codex verdict is not a Claude pass.
The command checks capability, not a running service's identity or model login.

If bubblewrap is missing, install it and socat in this distribution. If namespace
creation fails, follow the exact failure's doctor remedy and the official Claude
Linux/WSL2 troubleshooting instructions. On Ubuntu with AppArmor restrictions,
prefer the documented scoped bubblewrap profile; do not disable host-wide security
settings as an automatic repair. Re-run verification after any operator repair.
Unset `BUILDD_DISABLE_SANDBOX` for the sandbox route. The separate
`BUILDD_ALLOW_REDUCED_ISOLATION=1` opt-in permits trusted-local work without full
confinement; it never makes protected work eligible and is not a WSL setup step.

## 5. Start one runner and check its own report

Before replacing an existing Windows runner, let its active work finish. On Windows,
`buildd hold` prevents new claims; then close its foreground runner, or explicitly
`buildd service uninstall` for its Scheduled Task. Do not terminate an active task
just to migrate. Keep that service removed while using the WSL runner.

Inside Linux, start `buildd` in the foreground. Check its startup backend lines
and `buildd top`: Claude must report confinement by bubblewrap. In the dashboard,
check **this WSL runner's** current isolation report/heartbeat, not the old Windows
runner: `linux-wsl`, Claude `bwrap`, and a probe from its current process. Confirm
its configured workspace/task uses the Claude backend. If the running process
reports failure or no current probe, keep protected work blocked and diagnose it;
a standalone successful probe does not override the running runner's failure.

For a persistent runner, end the foreground process first, then check user systemd:

```bash
systemctl --user status
buildd service install
buildd service status
buildd service logs
```

If systemd/user services are unavailable, keep the foreground launcher in an open
WSL terminal. To enable systemd, follow
[Microsoft's WSL systemd instructions](https://learn.microsoft.com/windows/wsl/systemd)
explicitly, and restart the distribution from Windows after work has drained.
WSL shutdown ends Linux services; Windows reboot does not guarantee the distribution
starts. Open `wsl --distribution Ubuntu` after reboot, then check service status.
Do not add a second Windows Scheduled Task that runs the native runner.

The launcher/service restarts after runner updates. For an operator restart, drain
work with `buildd hold`, then uninstall/install the Linux service (or stop/start the
foreground launcher); use `buildd resume` when ready. Never run a foreground runner
and a service as competing supervisors. Recheck the new process's heartbeat after
restart. Linger, if desired, is an explicit operator choice described in README;
it does not guarantee Windows will start WSL after reboot.
