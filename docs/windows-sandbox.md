# Verifying native Windows Codex confinement

The runner tries explicit MXC first, then the unelevated restricted-token
sandbox. It checks `read-only` and `workspace-write` independently using the
executable resolved from its installed Codex SDK (or the runner's explicit
`CODEX_PATH_OVERRIDE`). Missing commands, failed launches, timeouts and failed
controls never establish confinement. Selection is cached with the runner's
process probe; startup rechecks the selected implementation using the worker's
actual `CODEX_HOME` and pins that executable in the SDK options. A failed startup
check ends the attempt without trying a weaker implementation.

Both selections currently report **writes only**. Protected tasks remain
blocked on native Windows: workers enable network access for buildd MCP and git,
so neither a filesystem test nor a successful offline sandbox test establishes
network confinement for those workers. Trusted local work follows the existing
workspace policy; unconfined execution still needs the operator's explicit
reduced-isolation opt-in. A failed sandbox never grants that opt-in.

## Run the enforcement harness

From the repository root on native Windows, with dependencies installed:

```powershell
powershell -NoProfile -File apps/runner/scripts/verify-windows-sandbox.ps1
```

No model login is needed. The harness resolves the SDK executable, prints its
version and Windows version, and uses disposable workspace, outside target and
home directories under the checkout. Host write controls establish that both
targets are writable. Sandbox commands must finish their success marker even
when the attempted write is denied. Workspace writes must succeed in
`workspace-write` and fail in `read-only`; outside writes must fail in both.

The network controls connect to `developers.openai.com:443` (override with
`-NetworkHost` and `-NetworkPort`). The same TCP endpoint must be reachable with
network enabled before and after the disabled-network test. A missing executable
or an unreachable endpoint makes the result inconclusive, not isolated. The
JSON output distinguishes these offline controls from the worker's effective
open-network configuration. A zero harness exit means evidence was collected;
inspect each `writesVerified` and `offlineNetworkControl` result.

The implementation baseline is Codex CLI/SDK 0.163.0 on native Windows 11
(NT build 26200). Enforcement depends on device support, managed requirements
and the runner's execution context; a version number alone proves nothing.
Nested restricted-token execution can fail before the control command runs.

## Operator provisioning and remaining work

The runner never selects `elevated`: its setup can provision local users,
firewall rules and local policy for a particular home. The operator must review
and perform provisioning explicitly. Probes do not invoke setup or request
elevation. Unelevated Codex may apply ACLs to its disposable writable roots;
the harness does not change unrelated host targets or firewall policy.

Protected native Windows support still needs an enforced network policy that
permits required buildd/git destinations while denying other destinations,
positive and negative network controls under the **same effective worker
configuration**, and independent verification on a supported host. Elevated
support also needs a way to reuse operator-provisioned state for each worker
home without silently provisioning or falling back. Until then, use an eligible
Linux/macOS runner for protected tasks.

See the [official Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox)
for MXC compatibility, explicit selection, legacy implementation limits and
operator-led elevated setup. This extension follows the approved Runner
isolation trust and failure rules; it does not assert approval of new Windows
requirements.
