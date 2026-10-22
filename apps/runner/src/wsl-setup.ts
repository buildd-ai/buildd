/** Read-only Windows preflight. No installations, credential reads or service changes. */
import { spawnSync } from 'child_process';
export interface CommandResult { code: number; stdout: string; missing?: boolean }
export type RunCommand = (file: string, args: string[]) => CommandResult;
const clean = (s: string) => s.replace(/\0/g, '').replace(/^\uFEFF/, '');
export function parseDistributions(output: string): { name: string; version: number }[] {
  return clean(output).split(/\r?\n/).flatMap(line => {
    // State is localized; names may contain spaces. Only the trailing WSL version matters.
    const m = line.match(/^\s*\*?\s*(.+?)\s+\S+\s+([12])\s*$/);
    return m ? [{ name: m[1], version: Number(m[2]) }] : [];
  });
}
const PREREQUISITES = ['git', 'curl', 'bun', 'bwrap', 'socat', 'claude', 'runner'];
// Fixed script: distribution names never enter a shell command. Starting a stopped
// distribution is the only lifecycle effect; no security configuration is changed.
export const WSL_RUNTIME_PROBE = `printf 'BUILDD_WSL_SETUP='; for c in git curl bun bwrap socat claude; do p=$(command -v "$c" 2>/dev/null); case "$p" in /mnt/*|*.exe|'') ;; *) printf '%s,' "$c" ;; esac; done; test ! -f "$HOME/.buildd/apps/runner/src/isolation-check.ts" || printf runner; printf '\\n'`;
const install = 'Operator only, in PowerShell as Administrator: wsl --install -d Ubuntu; reboot if requested, then open Ubuntu and create a Linux user.';
export function inspectWsl(platform: string, requested: string | undefined, run: RunCommand): { code: number; lines: string[] } {
  const lines = ['Claude confinement requires BOTH the runner and Claude inside WSL2. Native Windows Claude remains unsupported.'];
  const fail = (message: string) => ({ code: 1, lines: [...lines, message] });
  if (platform !== 'win32') return fail('Run this Windows preflight from PowerShell. Inside WSL use the verification command in apps/runner/WSL2.md.');
  const list = run('wsl.exe', ['--list', '--verbose']);
  if (list.missing) return fail(install);
  if (list.code !== 0) return fail(`WSL enumeration failed: ${clean(list.stdout).trim()}. Run wsl --list --verbose from an unrestricted PowerShell under the same Windows user; resolve that error before setup. No distribution readiness was established.`);
  const distros = parseDistributions(list.stdout);
  if (!distros.length) return fail(`${install} If distributions already exist, rerun wsl --list --verbose and inspect its output before installing another.`);
  const candidates = distros.filter(d => d.version === 2);
  const selected = requested ? distros.find(d => d.name === requested) : candidates.length === 1 ? candidates[0] : distros.length === 1 ? distros[0] : undefined;
  if (!selected) return fail(requested ? `Distribution not found: ${requested}. Run wsl --list --verbose and pass its exact name with --distro.` : 'Select a distribution explicitly: bun run wsl:setup --distro <name> (see wsl --list --verbose).');
  const quoted = '"' + selected.name.replace(/"/g, '""') + '"';
  if (selected.version !== 2) return fail(`Operator only: wsl --set-version ${quoted} 2; then rerun this preflight.`);
  lines.push(`Selected WSL2 distribution: ${selected.name}. Checking Linux commands (may start the distribution).`);
  const runtime = run('wsl.exe', ['--distribution', selected.name, '--exec', 'sh', '-lc', WSL_RUNTIME_PROBE]);
  if (runtime.code !== 0) return fail(`Distribution probe failed: ${clean(runtime.stdout).trim()}. Open wsl --distribution ${quoted} and resolve its startup error.`);
  const marker = clean(runtime.stdout).split(/\r?\n/).find(l => l.startsWith('BUILDD_WSL_SETUP='));
  if (!marker) return fail('Distribution returned no runtime probe result. Check its shell startup configuration.');
  const found = marker.slice('BUILDD_WSL_SETUP='.length).split(',');
  const missing = PREREQUISITES.filter(c => !found.includes(c));
  lines.push(missing.length ? `Missing Linux prerequisites: ${missing.join(', ')}.` : 'Linux commands found. This is not confinement verification.');
  lines.push(`Next: wsl --distribution ${quoted}`);
  if (missing.length) lines.push('Operator installation steps for Ubuntu/Debian (inside Linux; see apps/runner/WSL2.md):',
    '  sudo apt-get update && sudo apt-get install -y git curl unzip bubblewrap socat',
    '  curl -fsSL https://bun.sh/install | bash',
    '  curl -fsSL https://claude.ai/install.sh | bash',
    '  curl -fsSL https://buildd.dev/install.sh | bash',
    '  exec "$SHELL" -l');
  lines.push('Inside Linux: claude login; buildd login --device',
    'Verify: bun ~/.buildd/apps/runner/src/isolation-check.ts --verify-wsl',
    'Only after verification passes: buildd (foreground). Check this runner in buildd top and its current dashboard heartbeat.',
    'Follow apps/runner/WSL2.md for Linux repository paths and draining/removing a competing Windows service before startup.',
    'No Windows features, firewall rules, services or credentials were changed.');
  return { code: missing.length ? 1 : 0, lines };
}
export const realWslCommand: RunCommand = (file, args) => {
  const r = spawnSync(file, args, { timeout: 20_000, windowsHide: true });
  const decode = (b: Buffer | null) => !b ? '' : b.includes(0) ? b.toString('utf16le') : b.toString('utf8');
  return { code: r.status ?? 1, stdout: decode(r.stdout) + decode(r.stderr) + (r.error ? r.error.message : ''), missing: (r.error as NodeJS.ErrnoException)?.code === 'ENOENT' };
};
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--distro' && args[1] && !args[1].startsWith('-'))) {
    console.error('Usage: bun run wsl:setup [--distro <name>] (probe only)');
    process.exit(64);
  }
  const result = inspectWsl(process.platform, args[1], realWslCommand);
  console.log(result.lines.join('\n'));
  process.exit(result.code);
}
