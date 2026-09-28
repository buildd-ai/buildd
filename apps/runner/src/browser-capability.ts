/**
 * Truthful 'browser' capability: find a Chromium build AND prove it launches.
 *
 * Discovery covers system binaries on PATH (including Playwright's
 * `chrome-headless-shell`) and Playwright browser directories —
 * PLAYWRIGHT_BROWSERS_PATH, ~/.cache/ms-playwright, and the system-wide
 * /opt/ms-playwright that container images install into (a home directory
 * mounted as a volume hides anything the image put under ~/.cache).
 *
 * A binary on disk is not a capability: a snap stub or a build missing its
 * shared libraries is found and then fails. Each candidate is confirmed with a
 * short headless `--dump-dom about:blank` launch; success = exit 0 + HTML.
 * Successful probes are cached per path, so the periodic re-scan only
 * re-launches when the binary it finds changes. Failures are not cached — a
 * later `playwright install-deps` can fix them.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { homedir, tmpdir } from 'os';
import type { WorkerEnvironment } from '@buildd/shared';
import { CAPABILITY_BROWSER } from '@buildd/shared';

export const PATH_BROWSER_BINS = [
  'chromium',
  'chromium-browser',
  'google-chrome',
  'google-chrome-stable',
  'chrome-headless-shell',
  'headless_shell',
];

/** Executable names Playwright uses inside its browser directories. */
const PLAYWRIGHT_BIN_NAMES = ['chrome', 'chrome-headless-shell', 'headless_shell'];

export const SYSTEM_PLAYWRIGHT_DIR = '/opt/ms-playwright';

/** Bound on launches per scan so a host full of broken builds can't stall startup. */
const MAX_PROBES = 3;
const PROBE_TIMEOUT_MS = 10_000;

export interface BrowserProbeAttempt {
  path: string;
  source: 'path' | 'playwright';
  ok: boolean;
  exitCode?: number | null;
  /** Short reason when not ok: timeout, no html, spawn error. */
  reason?: string;
  stderrHead?: string;
}

export interface BrowserDetection {
  available: boolean;
  /** Binary whose launch probe passed. */
  path?: string;
  /** Playwright directories that existed and were searched. */
  searched: string[];
  attempts: BrowserProbeAttempt[];
}

const probeCache = new Map<string, BrowserProbeAttempt>();
let lastLogged: string | undefined;

/** Test hook: forget cached probes and the last logged line. */
export function resetBrowserCapabilityCache(): void {
  probeCache.clear();
  lastLogged = undefined;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isHeadlessShell(path: string): boolean {
  const name = basename(path);
  return name === 'chrome-headless-shell' || name === 'headless_shell';
}

/** Playwright directories to search, deduped, existing only. */
export function playwrightDirs(): string[] {
  const dirs: string[] = [];
  const env = process.env.PLAYWRIGHT_BROWSERS_PATH;
  // "0" means "next to the package in node_modules" — not a directory to scan.
  if (env && env !== '0') dirs.push(env);
  dirs.push(join(homedir(), '.cache', 'ms-playwright'));
  dirs.push(SYSTEM_PLAYWRIGHT_DIR);
  return [...new Set(dirs)].filter(d => existsSync(d));
}

function findOnPath(): string[] {
  const found: string[] = [];
  for (const bin of PATH_BROWSER_BINS) {
    try {
      const out = execSync(`which ${bin}`, { timeout: 2000, stdio: 'pipe' }).toString().trim();
      const first = out.split('\n')[0]?.trim();
      if (first) found.push(first);
    } catch { /* not on PATH */ }
  }
  return found;
}

function findInPlaywrightDirs(dirs: string[]): string[] {
  if (dirs.length === 0) return [];
  const names = PLAYWRIGHT_BIN_NAMES.map(n => `-name ${shellQuote(n)}`).join(' -o ');
  const cmd = `find ${dirs.map(shellQuote).join(' ')} -maxdepth 5 \\( ${names} \\) \\( -type f -o -type l \\) -perm -u+x 2>/dev/null | head -20`;
  try {
    return execSync(cmd, { timeout: 3000, stdio: 'pipe' })
      .toString()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function headOf(buf: unknown, max = 160): string | undefined {
  if (buf == null) return undefined;
  const s = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
  const line = s.split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The exact launch command used to confirm a binary works headless. */
export function browserProbeCommand(path: string): string {
  const headless = isHeadlessShell(path) ? '--headless' : '--headless=new';
  const profile = join(tmpdir(), 'buildd-browser-probe');
  return [
    shellQuote(path),
    headless,
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${shellQuote(profile)}`,
    '--dump-dom',
    'about:blank',
  ].join(' ');
}

function probe(path: string, source: BrowserProbeAttempt['source']): BrowserProbeAttempt {
  const cached = probeCache.get(path);
  if (cached) return { ...cached, source };
  try {
    const out = execSync(browserProbeCommand(path), { timeout: PROBE_TIMEOUT_MS, stdio: 'pipe' }).toString();
    if (/<html/i.test(out)) {
      const ok: BrowserProbeAttempt = { path, source, ok: true, exitCode: 0 };
      probeCache.set(path, ok);
      return ok;
    }
    return { path, source, ok: false, exitCode: 0, reason: 'no html on stdout' };
  } catch (err: any) {
    const timedOut = err?.code === 'ETIMEDOUT' || (err?.signal && err?.status == null);
    return {
      path,
      source,
      ok: false,
      exitCode: typeof err?.status === 'number' ? err.status : null,
      reason: timedOut ? `timeout after ${PROBE_TIMEOUT_MS}ms` : (err?.status == null ? headOf(err?.message) ?? 'spawn failed' : undefined),
      stderrHead: headOf(err?.stderr),
    };
  }
}

/** Find candidates and launch-probe them until one passes. Uncached discovery. */
export function detectBrowser(): BrowserDetection {
  const searched = playwrightDirs();
  const candidates: Array<{ path: string; source: BrowserProbeAttempt['source'] }> = [];
  const seen = new Set<string>();
  for (const path of findOnPath()) {
    if (!seen.has(path)) { seen.add(path); candidates.push({ path, source: 'path' }); }
  }
  for (const path of findInPlaywrightDirs(searched)) {
    if (!seen.has(path)) { seen.add(path); candidates.push({ path, source: 'playwright' }); }
  }

  const attempts: BrowserProbeAttempt[] = [];
  let launches = 0;
  for (const c of candidates) {
    // A cached success costs nothing; only real launches count against the cap.
    const cached = probeCache.has(c.path);
    if (!cached && launches >= MAX_PROBES) break;
    if (!cached) launches++;
    const a = probe(c.path, c.source);
    attempts.push(a);
    if (a.ok) return { available: true, path: a.path, searched, attempts };
  }
  return { available: false, searched, attempts };
}

/** One log line: what was found, or every path tried and why it failed. */
export function formatBrowserDetection(d: BrowserDetection): string {
  if (d.available) {
    return `[env-scan] browser: yes — ${d.path} passed headless launch probe`;
  }
  const dirs = d.searched.length ? d.searched.join(', ') : 'none present';
  if (d.attempts.length === 0) {
    return `[env-scan] browser: no — no Chromium on PATH (${PATH_BROWSER_BINS.join(', ')}) or in Playwright dirs (${dirs}). Install: npx playwright install --with-deps chromium`;
  }
  const tried = d.attempts.map(a => {
    const bits = [`exit=${a.exitCode ?? 'none'}`];
    if (a.reason) bits.push(a.reason);
    if (a.stderrHead) bits.push(`stderr: ${a.stderrHead}`);
    return `${a.path} (${bits.join('; ')})`;
  }).join(' | ');
  return `[env-scan] browser: no — launch probe failed for: ${tried}`;
}

/** Detect, and log one line when the outcome differs from the last one logged. */
export function checkBrowserCapability(): boolean {
  const d = detectBrowser();
  const line = formatBrowserDetection(d);
  if (line !== lastLogged) {
    console.log(line);
    lastLogged = line;
  }
  return d.available;
}

/** Return env with the browser key set to `available`; other keys untouched. */
export function applyBrowserCapability<T extends Pick<WorkerEnvironment, 'envKeys'>>(env: T, available: boolean): T {
  const without = env.envKeys.filter(k => k !== CAPABILITY_BROWSER);
  const envKeys = available ? [...without, CAPABILITY_BROWSER] : without;
  const unchanged = envKeys.length === env.envKeys.length && envKeys.every(k => env.envKeys.includes(k));
  return unchanged ? env : { ...env, envKeys };
}

/**
 * Cheap periodic re-scan: re-run only the browser check and fold the result
 * into the environment the next heartbeat sends. Picks up a browser installed
 * after startup, and drops the key when it disappears.
 */
export function rescanBrowserCapability(env: WorkerEnvironment | undefined): WorkerEnvironment | undefined {
  if (!env) return env;
  return applyBrowserCapability(env, checkBrowserCapability());
}

export const BROWSER_RESCAN_INTERVAL_MS = 10 * 60_000;
