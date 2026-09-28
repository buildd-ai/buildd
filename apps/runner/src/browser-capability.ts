/**
 * Truthful 'browser' capability: find a Chromium build AND prove it launches.
 *
 * Discovery covers Playwright browser directories — PLAYWRIGHT_BROWSERS_PATH,
 * ~/.cache/ms-playwright, and the system-wide /opt/ms-playwright that container
 * images install into (a home directory mounted as a volume hides anything the
 * image put under ~/.cache) — and system binaries on PATH (including
 * `chrome-headless-shell`). Playwright builds are probed first, headless shells
 * first among them: they are what agents actually launch, and a host's PATH
 * often carries snap stubs that would otherwise use up the launch budget.
 *
 * A binary on disk is not a capability: a snap stub or a build missing its
 * shared libraries is found and then fails. Each candidate is confirmed with a
 * short headless `--dump-dom about:blank` launch (argv, no shell, SIGKILL on
 * timeout); success = exit 0 + HTML. Successes are cached per path. Failures
 * are cached per path + mtime/inode for FAILURE_BACKOFF_MS, so a broken host
 * does not pay for launches on every re-scan, while a re-install (new mtime) or
 * the backoff expiring re-probes — a later `playwright install-deps` is picked up.
 *
 * The startup scan is synchronous (the first heartbeat needs an answer). The
 * periodic re-scan is async: its launches never block the event loop, and a
 * hung browser's whole process group is SIGKILLed on timeout.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
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

/** Bound on real launches per scan so a host full of broken builds can't stall startup. */
export const MAX_PROBES = 3;
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** How long a failed probe is trusted before the same unchanged binary is re-launched. */
export const FAILURE_BACKOFF_MS = 60 * 60_000;
/** Cap on captured probe output; `about:blank` is a few dozen bytes. */
const MAX_OUTPUT = 64 * 1024;

export interface BrowserProbeAttempt {
  path: string;
  source: 'path' | 'playwright';
  ok: boolean;
  exitCode?: number | null;
  /** Short reason when not ok: timeout, no html, spawn error. */
  reason?: string;
  stderrHead?: string;
  /** True when this result came from the cache rather than a launch. */
  cached?: boolean;
}

export interface BrowserDetection {
  available: boolean;
  /** Binary whose launch probe passed. */
  path?: string;
  /** Playwright directory holding `path`, when it came from one. */
  browsersRoot?: string;
  /** Playwright directories that existed and were searched. */
  searched: string[];
  attempts: BrowserProbeAttempt[];
}

interface Candidate {
  path: string;
  source: BrowserProbeAttempt['source'];
  root?: string;
}

interface FailureEntry {
  attempt: BrowserProbeAttempt;
  fingerprint: string;
  at: number;
}

const successCache = new Map<string, BrowserProbeAttempt>();
const failureCache = new Map<string, FailureEntry>();
let lastLogged: string | undefined;
let lastDetection: BrowserDetection | undefined;
let probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
let rescanInFlight: Promise<BrowserDetection> | undefined;

/** Test hook: forget cached probes, the last detection and the last logged line. */
export function resetBrowserCapabilityCache(): void {
  successCache.clear();
  failureCache.clear();
  lastLogged = undefined;
  lastDetection = undefined;
  rescanInFlight = undefined;
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS;
}

/** Test hook: shorten the launch timeout. */
export function setBrowserProbeTimeoutForTests(ms: number): void {
  probeTimeoutMs = ms;
}

/** The most recent detection (startup or re-scan), if any has run. */
export function getLastBrowserDetection(): BrowserDetection | undefined {
  return lastDetection;
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
  return [...new Set(dirs)].filter(d => fs.existsSync(d));
}

function realpathOf(p: string): string {
  try {
    return fs.realpathSync?.(p) ?? p;
  } catch {
    return p;
  }
}

/** A PATH entry that resolves into snapd is the 24.04 transition stub; it cannot run here. */
function isSnapPath(p: string): boolean {
  return p.startsWith('/snap/') || p.startsWith('/usr/lib/snapd/') || p === '/usr/bin/snap';
}

function findOnPath(): string[] {
  const found: string[] = [];
  for (const bin of PATH_BROWSER_BINS) {
    try {
      const out = cp.execSync(`which ${bin}`, { timeout: 2000, stdio: 'pipe' }).toString().trim();
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
    return cp.execSync(cmd, { timeout: 3000, stdio: 'pipe' })
      .toString()
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Ordered, deduped candidates: Playwright builds first (headless shells before
 * full Chromium), then PATH entries deduped by realpath with snap stubs dropped.
 */
export function collectBrowserCandidates(searched: string[]): Candidate[] {
  const out: Candidate[] = [];
  const seenReal = new Set<string>();
  const add = (c: Candidate) => {
    const real = realpathOf(c.path);
    if (seenReal.has(real)) return;
    seenReal.add(real);
    out.push(c);
  };

  const pw = findInPlaywrightDirs(searched).map(path => ({
    path,
    source: 'playwright' as const,
    root: searched.find(d => path === d || path.startsWith(d.endsWith('/') ? d : `${d}/`)),
  }));
  // Stable sort: headless shells first, discovery order otherwise.
  pw.sort((a, b) => Number(isHeadlessShell(b.path)) - Number(isHeadlessShell(a.path)));
  pw.forEach(add);

  for (const path of findOnPath()) {
    if (isSnapPath(realpathOf(path))) continue;
    add({ path, source: 'path' });
  }
  return out;
}

function headOf(buf: unknown, max = 160): string | undefined {
  if (buf == null) return undefined;
  const s = Buffer.isBuffer(buf) ? buf.toString() : String(buf);
  const line = s.split('\n').map(l => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The exact argv used to confirm a binary works headless. */
export function browserProbeArgs(path: string): string[] {
  const headless = isHeadlessShell(path) ? '--headless' : '--headless=new';
  return [
    headless,
    '--no-sandbox',
    '--disable-gpu',
    '--no-first-run',
    `--user-data-dir=${join(tmpdir(), 'buildd-browser-probe')}`,
    '--dump-dom',
    'about:blank',
  ];
}

/** mtime + inode: changes when the binary is replaced or reinstalled. */
function fingerprint(path: string): string {
  try {
    const st = fs.statSync(path);
    return `${st.mtimeMs}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

type Cached = { kind: 'hit'; attempt: BrowserProbeAttempt } | { kind: 'miss'; fp: string };

function lookup(c: Candidate): Cached {
  const ok = successCache.get(c.path);
  if (ok) return { kind: 'hit', attempt: { ...ok, source: c.source, cached: true } };
  const fp = fingerprint(c.path);
  const failed = failureCache.get(c.path);
  if (failed && failed.fingerprint === fp && Date.now() - failed.at < FAILURE_BACKOFF_MS) {
    return { kind: 'hit', attempt: { ...failed.attempt, source: c.source, cached: true } };
  }
  return { kind: 'miss', fp };
}

function record(a: BrowserProbeAttempt, fp: string): BrowserProbeAttempt {
  if (a.ok) {
    successCache.set(a.path, a);
    failureCache.delete(a.path);
  } else {
    failureCache.set(a.path, { attempt: a, fingerprint: fp, at: Date.now() });
  }
  return a;
}

function interpret(c: Candidate, stdout: string, exitCode: number | null, timedOut: boolean, stderr: unknown, spawnError?: string): BrowserProbeAttempt {
  const base = { path: c.path, source: c.source };
  if (timedOut) {
    return { ...base, ok: false, exitCode: null, reason: `timeout after ${probeTimeoutMs}ms`, stderrHead: headOf(stderr) };
  }
  if (spawnError) {
    return { ...base, ok: false, exitCode: null, reason: spawnError, stderrHead: headOf(stderr) };
  }
  if (exitCode === 0 && /<html/i.test(stdout)) return { ...base, ok: true, exitCode: 0 };
  if (exitCode === 0) return { ...base, ok: false, exitCode: 0, reason: 'no html on stdout' };
  return { ...base, ok: false, exitCode, stderrHead: headOf(stderr) };
}

function probeSync(c: Candidate): BrowserProbeAttempt {
  try {
    const out = cp.execFileSync(c.path, browserProbeArgs(c.path), {
      timeout: probeTimeoutMs,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: MAX_OUTPUT,
    });
    return interpret(c, String(out), 0, false, undefined);
  } catch (err: any) {
    const timedOut = err?.code === 'ETIMEDOUT' || (err?.signal != null && err?.status == null);
    const status = typeof err?.status === 'number' ? err.status : null;
    const spawnError = !timedOut && status == null ? headOf(err?.message) ?? 'spawn failed' : undefined;
    return interpret(c, String(err?.stdout ?? ''), status, timedOut, err?.stderr, spawnError);
  }
}

function killGroup(pid: number | undefined): void {
  if (!pid) return;
  try { process.kill(-pid, 'SIGKILL'); } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

function probeAsync(c: Candidate): Promise<BrowserProbeAttempt> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let exitCode: number | null = null;
    let child: ReturnType<typeof cp.spawn>;
    const finish = (a: BrowserProbeAttempt) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(closeGrace);
      resolve(a);
    };
    // A detached child leads its own process group, so the timeout can take
    // the zygote/GPU helpers down with it instead of orphaning them.
    const timer = setTimeout(() => {
      killGroup(child?.pid);
      finish(interpret(c, stdout, null, true, stderr));
    }, probeTimeoutMs);
    let closeGrace: ReturnType<typeof setTimeout> | undefined;
    try {
      child = cp.spawn(c.path, browserProbeArgs(c.path), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err: any) {
      finish(interpret(c, '', null, false, undefined, headOf(err?.message) ?? 'spawn failed'));
      return;
    }
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString(); });
    child.on('error', (err: Error) => finish(interpret(c, stdout, null, false, stderr, headOf(err.message) ?? 'spawn failed')));
    child.on('exit', (code: number | null) => {
      exitCode = code;
      // A leftover helper can hold the pipes open past the main process's exit.
      closeGrace = setTimeout(() => {
        killGroup(child.pid);
        finish(interpret(c, stdout, exitCode, false, stderr));
      }, 1000);
    });
    child.on('close', (code: number | null) => {
      finish(interpret(c, stdout, exitCode ?? code, false, stderr));
    });
    (child as any).unref?.();
  });
}

function finalize(searched: string[], attempts: BrowserProbeAttempt[], hit?: { a: BrowserProbeAttempt; c: Candidate }): BrowserDetection {
  const d: BrowserDetection = hit
    ? { available: true, path: hit.a.path, browsersRoot: hit.c.root, searched, attempts }
    : { available: false, searched, attempts };
  lastDetection = d;
  return d;
}

/** Find candidates and launch-probe them until one passes (blocking; startup). */
export function detectBrowser(): BrowserDetection {
  const searched = playwrightDirs();
  const attempts: BrowserProbeAttempt[] = [];
  let launches = 0;
  for (const c of collectBrowserCandidates(searched)) {
    const cached = lookup(c);
    let a: BrowserProbeAttempt;
    if (cached.kind === 'hit') a = cached.attempt;
    else {
      if (launches >= MAX_PROBES) break;
      launches++;
      a = record(probeSync(c), cached.fp);
    }
    attempts.push(a);
    if (a.ok) return finalize(searched, attempts, { a, c });
  }
  return finalize(searched, attempts);
}

/** Same as detectBrowser, but launches never block the event loop. */
export async function detectBrowserAsync(): Promise<BrowserDetection> {
  const searched = playwrightDirs();
  const attempts: BrowserProbeAttempt[] = [];
  let launches = 0;
  for (const c of collectBrowserCandidates(searched)) {
    const cached = lookup(c);
    let a: BrowserProbeAttempt;
    if (cached.kind === 'hit') a = cached.attempt;
    else {
      if (launches >= MAX_PROBES) break;
      launches++;
      a = record(await probeAsync(c), cached.fp);
    }
    attempts.push(a);
    if (a.ok) return finalize(searched, attempts, { a, c });
  }
  return finalize(searched, attempts);
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

function logIfChanged(d: BrowserDetection): void {
  const line = formatBrowserDetection(d);
  if (line !== lastLogged) {
    console.log(line);
    lastLogged = line;
  }
}

/**
 * Browser capability for the full environment scan. The first call detects
 * (blocking — startup needs an answer for the first heartbeat); later calls
 * reuse the latest detection, which the async re-scan keeps fresh, so the
 * 30-minute full scan never launches a browser on the event loop.
 */
export function checkBrowserCapability(): boolean {
  if (lastDetection) return lastDetection.available;
  const d = detectBrowser();
  logIfChanged(d);
  return d.available;
}

/** Async re-detect (single-flight), logging one line when the outcome changes. */
export function refreshBrowserCapability(): Promise<BrowserDetection> {
  if (!rescanInFlight) {
    rescanInFlight = detectBrowserAsync()
      .then(d => { logIfChanged(d); return d; })
      .finally(() => { rescanInFlight = undefined; });
  }
  return rescanInFlight;
}

/** Return env with the browser key set to `available`; other keys untouched. */
export function applyBrowserCapability<T extends Pick<WorkerEnvironment, 'envKeys'>>(env: T, available: boolean): T {
  const without = env.envKeys.filter(k => k !== CAPABILITY_BROWSER);
  const envKeys = available ? [...without, CAPABILITY_BROWSER] : without;
  const unchanged = envKeys.length === env.envKeys.length && envKeys.every(k => env.envKeys.includes(k));
  return unchanged ? env : { ...env, envKeys };
}

/**
 * Cheap periodic re-scan: re-run only the browser check (async) and fold the
 * result into the environment the next heartbeat sends. Picks up a browser
 * installed after startup, and drops the key when it disappears. `getEnv` is
 * read after the probe so a full scan that landed meanwhile is not overwritten.
 */
export async function rescanBrowserCapability(
  getEnv: () => WorkerEnvironment | undefined,
): Promise<WorkerEnvironment | undefined> {
  const d = await refreshBrowserCapability();
  const env = getEnv();
  return env ? applyBrowserCapability(env, d.available) : env;
}

/**
 * Point a spawned agent's Playwright at the build the runner verified. Agents
 * get a cleaned env; without PLAYWRIGHT_BROWSERS_PATH their Playwright falls
 * back to ~/.cache/ms-playwright (hidden by a home volume in images), so the
 * runner would advertise a browser the agent cannot find. An explicit value
 * the runner already passes through wins.
 */
export function applyAgentPlaywrightEnv(env: Record<string, string>, d: BrowserDetection | undefined = lastDetection): Record<string, string> {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env;
  if (d?.available && d.browsersRoot) env.PLAYWRIGHT_BROWSERS_PATH = d.browsersRoot;
  return env;
}

export const BROWSER_RESCAN_INTERVAL_MS = 10 * 60_000;
