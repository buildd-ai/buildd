/**
 * Live sibling conflict probe, runner half (server: apps/web/src/lib/sibling-conflict-probe.ts).
 *
 * The server saw this worker and a live sibling touch the same file and asked
 * this runner, which has the clone, to find out whether the two branches
 * actually conflict. `git merge-tree --write-tree` does the trial merge in the
 * object store: no checkout, no index, no effect on the agent's worktree.
 *
 * With the workspace's `gitConfig.mergiraf` on and the binary installed, each
 * conflicted file whose three stages exist is retried through
 * `mergiraf merge`; a file it merges cleanly is not a real conflict. (A clone
 * that registered mergiraf as a merge driver already applies it inside
 * merge-tree; the explicit pass covers clones that did not.)
 *
 * The fetch never touches the agent's state: `--no-write-fetch-head` leaves
 * FETCH_HEAD alone, the sibling's branch lands in a private ref
 * (`refs/buildd/probe/<probeId>`, deleted afterwards), and the server-supplied
 * branch name and probe id are validated before any git command runs, with
 * `--` ending option parsing wherever git takes a user-supplied argument.
 *
 * Async throughout (a fetch can take seconds; the sync loop must not block).
 * Never throws: every failure is an `error` result for the server to record.
 */
import { execFile, execSync } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import type { SiblingProbeConflict, SiblingProbeRequest, SiblingProbeResult } from '@buildd/shared';

const FETCH_TIMEOUT_MS = 60_000;
const MERGE_TIMEOUT_MS = 60_000;
const MERGIRAF_TIMEOUT_MS = 30_000;
const MAX_CONFLICTS = 100;
const MAX_HUNKS = 20;
const PROBE_REF_PREFIX = 'refs/buildd/probe/';

/**
 * A branch name safe to hand to git: the `git check-ref-format --branch`
 * rules that matter here, plus no leading `-` (never read as an option) and
 * nothing outside a conservative character set.
 */
export function isSafeBranchName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  return name.split('/').every(c => c.length > 0 && !c.startsWith('.') && !c.endsWith('.lock'));
}

const isSafeProbeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(id);
const isSha = (v: string): boolean => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v);

export interface SiblingProbeOptions {
  /** Resolved mergiraf binary; `undefined` looks it up, `null` means absent. */
  mergirafPath?: string | null;
  /** Skip the fetch (tests: the other branch is already a local ref). */
  otherRef?: string;
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[], timeout = MERGE_TIMEOUT_MS): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd, encoding: 'utf-8', timeout, maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export function findMergirafBinary(): string | null {
  try {
    return execSync('command -v mergiraf', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], shell: '/bin/sh' }).trim() || null;
  } catch {
    return null;
  }
}

interface MergeTreeOutput {
  tree: string;
  /** path → stage (1 base, 2 ours, 3 theirs) → blob oid */
  conflicted: Map<string, Map<number, string>>;
}

/**
 * Parse `git merge-tree --write-tree` (non -z) output: the tree oid, then one
 * `<mode> <oid> <stage>\t<path>` line per conflicted stage, then a blank line
 * and informational messages.
 */
export function parseMergeTreeOutput(out: string): MergeTreeOutput {
  const lines = out.split('\n');
  const tree = (lines[0] ?? '').trim();
  const conflicted = new Map<string, Map<number, string>>();
  for (const line of lines.slice(1)) {
    if (line.trim() === '') break;
    const m = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/.exec(line);
    if (!m) continue;
    const stages = conflicted.get(m[4]) ?? new Map<number, string>();
    stages.set(Number(m[3]), m[2]);
    conflicted.set(m[4], stages);
  }
  return { tree, conflicted };
}

/** Conflict regions in a merged file: 1-based line ranges from `<<<<<<<` to `>>>>>>>`. */
export function conflictHunks(content: string): SiblingProbeConflict['hunks'] {
  const hunks: SiblingProbeConflict['hunks'] = [];
  let start = 0;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length && hunks.length < MAX_HUNKS; i++) {
    if (lines[i].startsWith('<<<<<<<')) start = i + 1;
    else if (lines[i].startsWith('>>>>>>>') && start > 0) {
      hunks.push({ startLine: start, endLine: i + 1 });
      start = 0;
    }
  }
  return hunks;
}

/** Does mergiraf merge these three blobs without a conflict? */
async function mergirafResolves(cwd: string, mergiraf: string, path: string, stages: Map<number, string>): Promise<boolean> {
  const base = stages.get(1), ours = stages.get(2), theirs = stages.get(3);
  if (!base || !ours || !theirs) return false;
  const dir = await mkdtemp(join(tmpdir(), 'buildd-sibling-probe-'));
  try {
    // mergiraf picks the language from the extension, so keep the real name.
    const name = basename(path);
    const files = { base: join(dir, `base.${name}`), ours: join(dir, `ours.${name}`), theirs: join(dir, `theirs.${name}`) };
    await writeFile(files.base, await git(cwd, ['cat-file', 'blob', base]));
    await writeFile(files.ours, await git(cwd, ['cat-file', 'blob', ours]));
    await writeFile(files.theirs, await git(cwd, ['cat-file', 'blob', theirs]));
    await execFileAsync(mergiraf, ['merge', '-p', path, '-o', join(dir, `out.${name}`), files.base, files.ours, files.theirs], {
      timeout: MERGIRAF_TIMEOUT_MS,
    });
    return true; // exit 0: merged cleanly
  } catch {
    return false; // conflicts left (non-zero exit), unsupported language, or a failure
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runSiblingProbe(cwd: string, req: SiblingProbeRequest, opts: SiblingProbeOptions = {}): Promise<SiblingProbeResult> {
  const base: Pick<SiblingProbeResult, 'probeId'> = { probeId: req.probeId };
  if (!isSafeProbeId(req.probeId)) return { ...base, outcome: 'error', error: 'invalid probe id' };
  if (!isSafeBranchName(req.otherBranch)) return { ...base, outcome: 'error', error: 'invalid branch name' };
  const privateRef = `${PROBE_REF_PREFIX}${req.probeId}`;
  let fetched = false;
  try {
    let otherRef = opts.otherRef;
    if (!otherRef) {
      // Into a private ref, never FETCH_HEAD: the agent may be mid-`git diff ...FETCH_HEAD`.
      fetched = true;
      await git(cwd, ['fetch', '--no-tags', '--quiet', '--no-write-fetch-head', '--', 'origin', `+refs/heads/${req.otherBranch}:${privateRef}`], FETCH_TIMEOUT_MS);
      otherRef = privateRef;
    }
    const headSha = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'])).trim();
    const otherSha = (await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${otherRef}^{commit}`])).trim();
    // Both are now plain object ids, so nothing below can be read as an option.
    if (!isSha(headSha) || !isSha(otherSha)) throw new Error('rev-parse did not return a commit id');

    let out: string;
    try {
      out = await git(cwd, ['merge-tree', '--write-tree', headSha, otherSha]);
    } catch (err) {
      // Exit 1 = conflicts, with the same output on stdout. Anything else is an error.
      const e = err as { code?: unknown; stdout?: string };
      if (e.code !== 1 || typeof e.stdout !== 'string') throw err;
      out = e.stdout;
    }
    const parsed = parseMergeTreeOutput(out);
    if (parsed.conflicted.size === 0) return { ...base, outcome: 'clean', headSha, otherSha };

    const mergiraf = req.mergiraf
      ? (opts.mergirafPath === undefined ? findMergirafBinary() : opts.mergirafPath)
      : null;
    const conflicts: SiblingProbeConflict[] = [];
    const resolvedByMergiraf: string[] = [];
    for (const [path, stages] of [...parsed.conflicted].slice(0, MAX_CONFLICTS)) {
      if (mergiraf && await mergirafResolves(cwd, mergiraf, path, stages)) {
        resolvedByMergiraf.push(path);
        continue;
      }
      let hunks: SiblingProbeConflict['hunks'] = [];
      try { hunks = conflictHunks(await git(cwd, ['cat-file', '-p', `${parsed.tree}:${path}`])); } catch { /* modify/delete: no merged blob */ }
      conflicts.push({ path, hunks });
    }
    if (conflicts.length === 0) return { ...base, outcome: 'mergiraf_resolved', resolvedByMergiraf, headSha, otherSha };
    return { ...base, outcome: 'conflict', conflicts, ...(resolvedByMergiraf.length > 0 ? { resolvedByMergiraf } : {}), headSha, otherSha };
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    return { ...base, outcome: 'error', error: String(e.stderr || e.message || err).trim().slice(0, 300) };
  } finally {
    if (fetched) await git(cwd, ['update-ref', '-d', '--', privateRef]).catch(() => {});
  }
}

/** The per-worker fields the sync loop keeps for probes (see LocalWorker). */
export interface SiblingProbeQueue {
  worktreePath?: string;
  siblingProbeQueue?: SiblingProbeRequest[];
  siblingProbeRunning?: boolean;
  pendingSiblingProbeResults?: SiblingProbeResult[];
}

/**
 * Queue the probes a heartbeat handed out and run them one at a time in the
 * background; each result waits in `pendingSiblingProbeResults` for the next
 * sync. A probe already queued or running is not queued twice. Returns the
 * drain promise (tests await it; the sync loop does not).
 */
export function enqueueSiblingProbes(
  worker: SiblingProbeQueue,
  probes: unknown,
  run: (cwd: string, req: SiblingProbeRequest) => Promise<SiblingProbeResult> = runSiblingProbe,
): Promise<void> | null {
  if (!Array.isArray(probes) || !worker.worktreePath) return null;
  const queue = worker.siblingProbeQueue ??= [];
  for (const p of probes.slice(0, 5) as SiblingProbeRequest[]) {
    if (!p || typeof p.probeId !== 'string' || typeof p.otherBranch !== 'string') continue;
    if (!queue.some(q => q.probeId === p.probeId)) queue.push(p);
  }
  if (worker.siblingProbeRunning || queue.length === 0) return null;
  worker.siblingProbeRunning = true;
  return (async () => {
    try {
      while (queue.length > 0) {
        const req = queue.shift()!;
        const cwd = worker.worktreePath;
        if (!cwd) break;
        (worker.pendingSiblingProbeResults ??= []).push(await run(cwd, req));
      }
    } finally {
      worker.siblingProbeRunning = false;
    }
  })();
}
