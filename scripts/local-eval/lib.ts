/**
 * I/O for the local replay evaluation (rules live in packages/core/local-eval.ts).
 *
 * Isolation model: the agent's workspace is a `git archive` of the pre-fix SHA
 * re-initialised as ONE commit with no remote. The source repository, the fix
 * commit, the hidden tests and every reference patch stay outside it. Hidden
 * tests are read from the source repository by the evaluator after the agent
 * finishes and copied in only then.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChangedFile, Suite, SuiteCase, CheckOutcome } from '../../packages/core/local-eval';

export function sh(cmd: string, args: string[], opts: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, input: opts.input, env: opts.env ?? process.env, encoding: 'utf8', timeout: opts.timeoutMs, maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? (r.signal ? 143 : 1), out: r.stdout ?? '', err: r.stderr ?? '' };
}

export function git(cwd: string, ...args: string[]): string {
  const r = sh('git', args, { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim()}`);
  return r.out;
}

/** Package directories whose node_modules the tree borrows from the host checkout. */
function packageDirs(depsFrom: string): string[] {
  const out = [''];
  for (const root of ['apps', 'packages']) {
    const p = join(depsFrom, root);
    if (!existsSync(p)) continue;
    for (const d of readdirSync(p)) if (existsSync(join(p, d, 'node_modules'))) out.push(`${root}/${d}`);
  }
  return out;
}

export interface Workspace { dir: string; baseline: string }

/**
 * Export `preFixSha` from `sourceRepo` into `dir` as a single-commit
 * repository with no remote. `depsFrom` supplies installed dependencies as
 * symlinks (excluded from the baseline commit).
 */
export function createWorkspace(sourceRepo: string, preFixSha: string, dir: string, depsFrom: string): Workspace {
  mkdirSync(dir, { recursive: true });
  const tarPath = join(dir, '..', `.export-${preFixSha.slice(0, 10)}.tar`);
  const a = sh('git', ['-C', sourceRepo, 'archive', '--format=tar', '-o', tarPath, preFixSha]);
  if (a.code !== 0) throw new Error(`git archive failed: ${a.err}`);
  const x = sh('tar', ['-xf', tarPath, '-C', dir]);
  rmSync(tarPath, { force: true });
  if (x.code !== 0) throw new Error(`tar failed: ${x.err}`);
  git(dir, 'init', '-q', '-b', 'baseline');
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules\n**/node_modules\n');
  git(dir, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'add', '-A');
  git(dir, '-c', 'user.name=eval', '-c', 'user.email=eval@localhost', 'commit', '-q', '-m', 'baseline');
  for (const rel of packageDirs(depsFrom)) {
    const link = join(dir, rel, 'node_modules');
    if (!existsSync(join(dir, rel))) continue;
    if (!existsSync(link)) symlinkSync(join(depsFrom, rel, 'node_modules'), link);
  }
  return { dir, baseline: git(dir, 'rev-parse', 'HEAD').trim() };
}

function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, rel))) {
    if (name === '.git' || name === 'node_modules') continue;
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(join(dir, r));
    if (st.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}

/** Hidden tests whose workspace content equals the fix commit's version. Compared outside the workspace. */
export function answerBearingTests(sourceRepo: string, ws: Workspace, c: SuiteCase): string[] {
  const out: string[] = [];
  for (const t of c.hiddenTests) {
    const p = join(ws.dir, t);
    const fixed = sh('git', ['-C', sourceRepo, 'show', `${c.reference.fixSha}:${t}`]);
    if (existsSync(p) && fixed.code === 0 && readFileSync(p, 'utf8') === fixed.out) out.push(t);
  }
  return out;
}

export function probeWorkspace(dir: string) {
  const log = sh('git', ['log', '--format=%H', '--all'], { cwd: dir });
  const remotes = sh('git', ['remote'], { cwd: dir }).out.split('\n').map((s) => s.trim()).filter(Boolean);
  return { paths: walk(dir), answerBearingTests: [] as string[], commits: log.out.split('\n').map((s) => s.trim()).filter(Boolean), remotes };
}

/** What the agent changed relative to the baseline commit, including new files. */
export function changedFiles(ws: Workspace): ChangedFile[] {
  git(ws.dir, 'add', '-A');
  const names = git(ws.dir, 'diff', '--cached', '--name-status', '--no-renames', ws.baseline).split('\n').filter(Boolean);
  const out: ChangedFile[] = [];
  for (const line of names) {
    const [s, ...rest] = line.split('\t');
    const path = rest.join('\t');
    const status = s === 'A' ? 'added' : s === 'D' ? 'deleted' : 'modified';
    const patch = status === 'deleted' ? '' : git(ws.dir, 'diff', '--cached', '--no-renames', ws.baseline, '--', path);
    out.push({ path, status, patch });
  }
  return out;
}

export function fullDiff(ws: Workspace): string {
  git(ws.dir, 'add', '-A');
  return git(ws.dir, 'diff', '--cached', '--no-renames', ws.baseline);
}

/** Pristine copies of the test-runner files, so a tampered runner cannot grade its own work. */
export const PRISTINE_RUNNER_FILES = ['bunfig.toml', 'scripts/run-unit-tests.ts'];

export function restoreRunner(sourceRepo: string, ws: Workspace, preFixSha: string) {
  for (const f of PRISTINE_RUNNER_FILES) {
    const r = sh('git', ['-C', sourceRepo, 'show', `${preFixSha}:${f}`]);
    if (r.code === 0) { mkdirSync(dirname(join(ws.dir, f)), { recursive: true }); writeFileSync(join(ws.dir, f), r.out); }
  }
}

/** Copy the hidden tests from the fix commit into the workspace. Call only after the agent has finished. */
export function injectHiddenTests(sourceRepo: string, ws: Workspace, c: SuiteCase) {
  for (const t of c.hiddenTests) {
    const r = sh('git', ['-C', sourceRepo, 'show', `${c.reference.fixSha}:${t}`]);
    if (r.code !== 0) throw new Error(`hidden test ${t} missing at ${c.reference.fixSha}: ${r.err}`);
    mkdirSync(dirname(join(ws.dir, t)), { recursive: true });
    writeFileSync(join(ws.dir, t), r.out);
  }
}

/** Overwrite the files the reference fix changed (admission only: never in an agent run). */
export function applyReference(sourceRepo: string, ws: Workspace, c: SuiteCase) {
  const files = git(sourceRepo, 'diff', '--name-only', c.reference.preFixSha, c.reference.fixSha).split('\n').filter(Boolean);
  for (const f of files) {
    const r = sh('git', ['-C', sourceRepo, 'show', `${c.reference.fixSha}:${f}`]);
    if (r.code !== 0) { rmSync(join(ws.dir, f), { force: true }); continue; }
    mkdirSync(dirname(join(ws.dir, f)), { recursive: true });
    writeFileSync(join(ws.dir, f), r.out);
  }
}

/** One test process per file, as the repo's own runner does. */
export function runTests(ws: Workspace, files: string[], timeoutMs = 600_000): CheckOutcome & { output: string } {
  if (!files.length) return { ran: false, passed: null, output: '' };
  const r = sh('bun', ['run', 'scripts/run-unit-tests.ts', ...files], { cwd: ws.dir, timeoutMs });
  const output = `${r.out}\n${r.err}`;
  return { ran: r.code !== 143, passed: r.code === 0, output: output.slice(-20000) };
}

export function loadSuite(path: string): Suite { return JSON.parse(readFileSync(path, 'utf8')) as Suite; }

export function tempDir(prefix: string): string { return mkdtempSync(join(process.env.LOCAL_EVAL_TMP ?? '/tmp', prefix)); }
