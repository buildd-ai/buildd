/**
 * Windows side of the WSL2 setup (Living Spec a0b82b5d, part 1).
 *
 * `bun run wsl:setup` (this file's entry point, `inspectWsl`) is the read-only
 * preflight: no installations, credential reads or service changes.
 * `buildd wsl install` (`installWsl`) reuses its detection and installs WSL and
 * Ubuntu only after the operator says yes in their own terminal.
 */
import { spawnSync } from 'child_process';
import { WSL2_DOCS_URL } from '@buildd/shared';
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
type Distro = { name: string; version: number };
const quoteDistro = (name: string) => '"' + name.replace(/"/g, '""') + '"';
/** One WSL2 distribution to use, or why there is none. A WSL1 one is never converted here. */
function selectDistribution(distros: Distro[], requested: string | undefined, command: string, rerun: string): { selected: Distro } | { message: string } {
  const candidates = distros.filter(d => d.version === 2);
  const selected = requested ? distros.find(d => d.name === requested) : candidates.length === 1 ? candidates[0] : distros.length === 1 ? distros[0] : undefined;
  if (!selected) return { message: requested ? `Distribution not found: ${requested}. Run wsl --list --verbose and pass its exact name with --distro.` : `Select a distribution explicitly: ${command} --distro <name> (see wsl --list --verbose).` };
  if (selected.version !== 2) return { message: `Operator only: wsl --set-version ${quoteDistro(selected.name)} 2; then rerun ${rerun}.` };
  return { selected };
}
const PREREQUISITES = ['git', 'curl', 'bun', 'bwrap', 'socat', 'claude', 'runner'];
// Fixed script: distribution names never enter a shell command. Starting a stopped
// distribution is the only lifecycle effect; no security configuration is changed.
// Same user bin directories the install.sh launcher adds, so tools installed via interactive-shell config are found.
export const WSL_RUNTIME_PROBE = `PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"; export PATH; printf 'BUILDD_WSL_SETUP='; for c in git curl bun bwrap socat claude; do p=$(command -v "$c" 2>/dev/null); case "$p" in /mnt/*|*.exe|'') ;; *) printf '%s,' "$c" ;; esac; done; test ! -f "$HOME/.buildd/apps/runner/src/isolation-check.ts" || printf runner; printf '\\n'`;
const CONFINEMENT = 'Claude confinement requires BOTH the runner and Claude inside WSL2. Native Windows Claude remains unsupported.';
const install = 'Operator only, in PowerShell as Administrator: wsl --install -d Ubuntu; reboot if requested, then open Ubuntu and create a Linux user.';
const LINUX_NEXT_STEPS = [
  'Inside Linux: claude login; buildd login --device',
  'Verify: bun ~/.buildd/apps/runner/src/isolation-check.ts --verify-wsl',
  'Only after verification passes: buildd (foreground). Check this runner in buildd top and its current dashboard heartbeat.',
  `Follow ${WSL2_DOCS_URL} for Linux repository paths and draining/removing a competing Windows service before startup.`,
];
export function inspectWsl(platform: string, requested: string | undefined, run: RunCommand): { code: number; lines: string[] } {
  const lines = [CONFINEMENT];
  const fail = (message: string) => ({ code: 1, lines: [...lines, message] });
  if (platform !== 'win32') return fail(`Run this Windows preflight from PowerShell. Inside WSL use the verification command in ${WSL2_DOCS_URL}#verify`);
  const list = run('wsl.exe', ['--list', '--verbose']);
  if (list.missing) return fail(install);
  if (list.code !== 0) return fail(`WSL enumeration failed: ${clean(list.stdout).trim()}. Run wsl --list --verbose from an unrestricted PowerShell under the same Windows user; resolve that error before setup. No distribution readiness was established.`);
  const distros = parseDistributions(list.stdout);
  if (!distros.length) return fail(`${install} If distributions already exist, rerun wsl --list --verbose and inspect its output before installing another.`);
  const pick = selectDistribution(distros, requested, 'bun run wsl:setup', 'this preflight');
  if ('message' in pick) return fail(pick.message);
  const selected = pick.selected;
  const quoted = quoteDistro(selected.name);
  lines.push(`Selected WSL2 distribution: ${selected.name}. Checking Linux commands (may start the distribution).`);
  const runtime = run('wsl.exe', ['--distribution', selected.name, '--exec', 'sh', '-lc', WSL_RUNTIME_PROBE]);
  if (runtime.code !== 0) return fail(`Distribution probe failed: ${clean(runtime.stdout).trim()}. Open wsl --distribution ${quoted} and resolve its startup error.`);
  const marker = clean(runtime.stdout).split(/\r?\n/).find(l => l.startsWith('BUILDD_WSL_SETUP='));
  if (!marker) return fail('Distribution returned no runtime probe result. Check its shell startup configuration.');
  const found = marker.slice('BUILDD_WSL_SETUP='.length).split(',');
  const missing = PREREQUISITES.filter(c => !found.includes(c));
  lines.push(missing.length ? `Missing Linux prerequisites: ${missing.join(', ')}.` : 'Linux commands found. This is not confinement verification.');
  lines.push(`Next: wsl --distribution ${quoted}`);
  if (missing.length) lines.push(`Operator installation steps for Ubuntu/Debian (inside Linux; see ${WSL2_DOCS_URL}):`,
    '  sudo apt-get update && sudo apt-get install -y git curl unzip bubblewrap socat',
    '  curl -fsSL https://bun.sh/install | bash',
    '  curl -fsSL https://claude.ai/install.sh | bash',
    '  curl -fsSL https://buildd.dev/install.sh | bash',
    '  exec "$SHELL" -l');
  lines.push(...LINUX_NEXT_STEPS, 'No Windows features, firewall rules, services or credentials were changed.');
  return { code: missing.length ? 1 : 0, lines };
}
export const MIN_WINDOWS_BUILD = 19041;
const INSTALL_ARGS = ['--install', '-d', 'Ubuntu', '--no-launch'];
const INSTALL_COMMAND = `wsl ${INSTALL_ARGS.join(' ')}`;
/** Fixed script run inside the distribution as its default user; the distribution name is only ever an argument. */
export const LINUX_INSTALLER = `command -v curl >/dev/null 2>&1 || { echo 'curl is missing. Install curl in Linux, then run buildd wsl install again from PowerShell.' >&2; exit 1; }; curl -fsSL https://buildd.dev/install.sh | bash`;
// The machine has WSL (or only its stub) but no distribution. Error codes are not localized; the English texts cover older WSL.
const NO_DISTRIBUTIONS = /WSL_E_DEFAULT_DISTRO_NOT_FOUND|WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED|has no installed distributions|Subsystem for Linux is not installed/i;

/** The build from os.release() ("10.0.<build>" on Windows), or null when it does not read as one. */
export function parseWindowsBuild(release: string): number | null {
  const m = release.match(/^\d+\.\d+\.(\d+)/);
  return m ? Number(m[1]) : null;
}

type Listing = { kind: 'none' } | { kind: 'failed'; detail: string } | { kind: 'listed'; distros: Distro[] };
function readListing(run: RunCommand): Listing {
  const list = run('wsl.exe', ['--list', '--verbose']);
  if (list.missing) return { kind: 'none' };
  if (list.code !== 0) return NO_DISTRIBUTIONS.test(clean(list.stdout)) ? { kind: 'none' } : { kind: 'failed', detail: clean(list.stdout).trim() };
  const distros = parseDistributions(list.stdout);
  return distros.length ? { kind: 'listed', distros } : { kind: 'none' };
}

/** Whether the distribution's default user is an ordinary (non-root) Linux user. */
function hasOrdinaryUser(run: RunCommand, name: string): boolean {
  const r = run('wsl.exe', ['--distribution', name, '--exec', 'id', '-u']);
  const uid = Number(clean(r.stdout).trim());
  return r.code === 0 && Number.isInteger(uid) && uid > 0;
}

export interface WslInstallDeps {
  platform: string;
  /** os.release(): "10.0.<build>" on Windows. */
  release: string;
  /** Captured, for queries. */
  run: RunCommand;
  /** With the operator's terminal attached, so Windows and Linux can ask their own questions; returns the exit code. */
  runInteractive: (file: string, args: string[]) => number;
  /** null when there is no terminal to ask on, which counts as no. */
  confirm: ((question: string) => Promise<boolean>) | null;
  out: (line: string) => void;
}

/**
 * `buildd wsl install [--distro <name>]`: from nothing to the Linux installer
 * running inside a WSL2 distribution as an ordinary user. Installs WSL and
 * Ubuntu only after a yes; reuses any usable distribution; never converts
 * WSL1, creates a Linux user or runs the installer as root.
 */
export async function installWsl(requested: string | undefined, d: WslInstallDeps): Promise<number> {
  const say = (...lines: string[]) => lines.forEach(l => d.out(l));
  if (d.platform !== 'win32') {
    say('buildd wsl install runs on Windows, from PowerShell. Inside WSL, run the Linux installer instead: curl -fsSL https://buildd.dev/install.sh | bash');
    return 1;
  }
  const build = parseWindowsBuild(d.release);
  const needed = `buildd wsl install needs Windows 10 build ${MIN_WINDOWS_BUILD} or later, or Windows 11`;
  if (build === null) { say(`Could not read the Windows build from "${d.release}". ${needed}. Nothing was changed.`); return 1; }
  if (build < MIN_WINDOWS_BUILD) { say(`This is Windows build ${build}. ${needed}: update Windows, then run it again. Nothing was changed.`); return 1; }
  say(CONFINEMENT);

  let listing = readListing(d.run);
  if (listing.kind === 'failed') {
    say(`WSL enumeration failed: ${listing.detail}. Run wsl --list --verbose from an unrestricted PowerShell under the same Windows user and resolve that error. Nothing was installed: a failed listing does not mean there is no distribution.`);
    return 1;
  }
  if (listing.kind === 'none') {
    if (requested && requested !== 'Ubuntu') { say(`Distribution not found: ${requested}. buildd wsl install installs only Ubuntu: run it without --distro.`); return 1; }
    say('No WSL2 distribution was found.',
      `This installs WSL and Ubuntu: ${INSTALL_COMMAND}`,
      'It changes Windows features, may ask for administrator rights, and may need a restart.',
      'If you installed Ubuntu before and never opened it, open Ubuntu from the Start menu once instead, then run buildd wsl install again.');
    const yes = d.confirm ? await d.confirm(`Run ${INSTALL_COMMAND} now? [y/N] `) : false;
    if (!yes) { say(`Nothing was installed. To install it yourself, run in PowerShell: ${INSTALL_COMMAND}`, 'Then run buildd wsl install again.'); return 1; }
    const code = d.runInteractive('wsl.exe', INSTALL_ARGS);
    if (code !== 0) { say(`${INSTALL_COMMAND} failed (exit ${code}). Resolve the error above, then run buildd wsl install again.`); return 1; }
    say(`Ran ${INSTALL_COMMAND}.`);
    listing = readListing(d.run);
    if (listing.kind !== 'listed') {
      say('Windows needs a restart to finish installing WSL and Ubuntu. Restart, then run buildd wsl install again: it continues from here.',
        'If Ubuntu is still not listed after the restart, open Ubuntu from the Start menu once, then run it again.');
      return 1;
    }
  }

  const pick = selectDistribution(listing.distros, requested, 'buildd wsl install', 'buildd wsl install');
  if ('message' in pick) { say(pick.message); return 1; }
  const name = pick.selected.name;
  const quoted = quoteDistro(name);
  say(`Using WSL2 distribution: ${name}.`);

  if (!hasOrdinaryUser(d.run, name)) {
    say(`${name} has no ordinary Linux user yet. It opens now: create your Linux user and password when asked, then type exit to come back here.`);
    d.runInteractive('wsl.exe', ['--distribution', name]);
    if (!hasOrdinaryUser(d.run, name)) {
      say(`${name}'s default user is still root. buildd never runs its installer as root and never creates a user for you.`,
        `Create one inside ${name} (adduser <name>), make it the default (wsl --manage ${quoted} --set-default-user <name>), then run buildd wsl install again.`);
      return 1;
    }
  }

  say(`Running the buildd Linux installer inside ${name} as your Linux user. Its questions appear here.`);
  const code = d.runInteractive('wsl.exe', ['--distribution', name, '--exec', 'bash', '-lc', LINUX_INSTALLER]);
  if (code !== 0) { say(`The Linux installer stopped (exit ${code}). Fix what it reported, then run buildd wsl install again.`); return 1; }
  say('The Linux installer finished.', `Next: wsl --distribution ${quoted}`, ...LINUX_NEXT_STEPS);
  return 0;
}

export const realWslInteractive = (file: string, args: string[]): number =>
  spawnSync(file, args, { stdio: 'inherit' }).status ?? 1;

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
