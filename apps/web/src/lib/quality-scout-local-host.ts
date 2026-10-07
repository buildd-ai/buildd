/**
 * A local Quality Scout host: the same `runQualityScout` pipeline the server
 * trigger runs, with its world supplied by a git checkout on this machine
 * instead of the GitHub App and the database. For a runner, a worker sandbox
 * or a person at a terminal — anywhere that has a checkout and no prod DB.
 *
 *  - **Profile** — readiness computed from `git ls-tree` at the candidate SHA
 *    (the same manifest allow-list the server reads), projected by
 *    `discoverScoutCapabilities` exactly as the server does.
 *  - **Command port** — runs a declared command in the checkout, but only when
 *    the checkout IS the candidate (HEAD at the SHA, nothing uncommitted), and
 *    records whether the command changed the tree. A probe that dirties the
 *    checkout is reported, never silently absorbed.
 *  - **Decider** — the probe-selection kind's own rules and fallback. That is
 *    what the server runs today too: the kind is bound in shadow, so a model's
 *    pick is recorded and the fallback decides. No model is called here.
 *  - **Ledger + action store** — in memory (optionally persisted to a JSON
 *    file between invocations), with an audit of every write the action policy
 *    makes. A "filed" follow-up lands in this store, never in buildd.
 *
 * Nothing here pushes, merges, writes Recall or creates a buildd task.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeReadiness, type ReadinessReport } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import { SCOUT_PROBE_SELECTION_CONFIG } from '@buildd/core/decision-kind-scout-probe-selection';
import type { ScoutFindingStore } from '@buildd/core/quality-scout/ledger';
import type { ScoutCommandOutput, ScoutCommandRequest } from '@buildd/core/quality-scout/executors';
import type { ScoutProbeDecider } from '@buildd/core/quality-scout/selector';
import type {
  ScoutActionState,
  ScoutFinding,
  ScoutProbeRecord,
  ScoutRun,
  ScoutRunMetrics,
  ScoutRunTotals,
} from '@buildd/core/quality-scout/types';
import { isTerminalTaskStatus } from '@buildd/shared';
import { MAX_MANIFEST_BYTES, selectManifestPaths } from './workspace-readiness-io';
import type { ScoutActionStore, ScoutFollowUpTaskInput } from './quality-scout-actions';
import type { ScoutRunLedger } from './quality-scout-run';

const TAIL_CHARS = 4_000;

// ── git ─────────────────────────────────────────────────────────────────────

export interface Exec {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

/** Run a process; never throws. `timeoutMs` kills the whole process group. */
export function exec(cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<Exec> {
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, detached: true });
    } catch (err) {
      resolve({ code: null, stdout: '', stderr: String(err), timedOut: false, durationMs: 0 });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d) => { stdout += d; });
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

async function git(dir: string, args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd: dir, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
}

export const gitHead = async (dir: string) => (await git(dir, ['rev-parse', 'HEAD'])).trim();
export const gitStatus = async (dir: string) => git(dir, ['status', '--porcelain', '--untracked-files=all']);

export async function gitChangedPaths(dir: string, base: string, head: string): Promise<string[]> {
  return (await git(dir, ['diff', '--name-only', `${base}...${head}`])).split('\n').filter(Boolean);
}

/** The readiness report at `sha`, from the committed tree — never the working copy. */
export async function gitReadiness(dir: string, sha: string, gitConfig?: Record<string, unknown> | null): Promise<ReadinessReport> {
  const blobs = (await git(dir, ['ls-tree', '-r', '-l', '--full-tree', sha]))
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const m = line.match(/^\d+\s+blob\s+[0-9a-f]+\s+(\d+|-)\t(.+)$/);
      return m ? [{ path: m[2], size: m[1] === '-' ? undefined : Number(m[1]) }] : [];
    });
  const manifests: Record<string, string> = {};
  for (const p of selectManifestPaths(blobs, null)) {
    const b = blobs.find((x) => x.path === p);
    if (b?.size !== undefined && b.size > MAX_MANIFEST_BYTES) continue;
    manifests[p] = await git(dir, ['show', `${sha}:${p}`]);
  }
  return computeReadiness({ files: blobs.map((b) => b.path), manifests, gitConfig: (gitConfig ?? null) as never, deployments: null });
}

export async function gitScoutProfile(dir: string, sha: string, extension: unknown, gitConfig?: Record<string, unknown> | null): Promise<ScoutCapabilityProfile> {
  return discoverScoutCapabilities({ readiness: await gitReadiness(dir, sha, gitConfig), extension });
}

// ── Command port ────────────────────────────────────────────────────────────

export interface LocalCommandRecord {
  request: ScoutCommandRequest;
  output: ScoutCommandOutput;
  /** `git status` lines the command added: anything here means the probe wrote to the checkout. */
  treeChanges: string[];
}

/**
 * Runs a probe's command in `dir`, which must be a clean checkout of the
 * candidate SHA. Anything else is refused with no exit code (the judge reads
 * that as `inconclusive`), so a probe never reports on a tree it did not test.
 */
export function localCommandPort(opts: { dir: string; evidenceDir: string; env?: NodeJS.ProcessEnv }) {
  const records: LocalCommandRecord[] = [];
  let n = 0;
  return {
    records,
    port: {
      async run(req: ScoutCommandRequest): Promise<ScoutCommandOutput> {
        const head = await gitHead(opts.dir).catch(() => null);
        const before = await gitStatus(opts.dir).catch(() => null);
        if (head !== req.sha || before === null || before.trim() !== '') {
          const why = head !== req.sha ? `checkout is at ${head?.slice(0, 12) ?? 'unknown'}, not ${req.sha.slice(0, 12)}` : 'checkout has uncommitted changes';
          const output: ScoutCommandOutput = { exitCode: null, timedOut: false, stderrTail: `refused: ${why}` };
          records.push({ request: req, output, treeChanges: [] });
          return output;
        }
        const r = await exec('bash', ['-c', req.command], { cwd: opts.dir, timeoutMs: req.timeoutMs, env: opts.env });
        mkdirSync(opts.evidenceDir, { recursive: true });
        // Unique per process and call: an evidence log is never overwritten by a later run.
        const file = join(opts.evidenceDir, `command-${req.sha.slice(0, 12)}-${process.pid}-${Date.now()}-${++n}.log`);
        writeFileSync(file, `$ ${req.command}\n# ref ${req.ref} sha ${req.sha}\n# exit ${r.code} timedOut ${r.timedOut} ${r.durationMs}ms\n\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n`);
        const after = (await gitStatus(opts.dir).catch(() => '')).split('\n').filter(Boolean);
        const output: ScoutCommandOutput = {
          exitCode: r.code,
          timedOut: r.timedOut,
          durationMs: r.durationMs,
          stdoutTail: r.stdout.slice(-TAIL_CHARS),
          stderrTail: r.stderr.slice(-TAIL_CHARS),
          evidenceRef: `file:${file}`,
        };
        records.push({ request: req, output, treeChanges: after });
        return output;
      },
    },
  };
}

// ── Decider ─────────────────────────────────────────────────────────────────

/** The kind's override, then its fallback — what decides in shadow binding. No model, no cost. */
export const ruleScoutProbeDecider: ScoutProbeDecider = async (request) => {
  const k = SCOUT_PROBE_SELECTION_CONFIG;
  const override = k.override?.(request.features);
  if (override) return { ...override, source: 'rule' };
  return { ...k.fallback(request.features, 'shadow'), source: 'fallback' };
};

// ── Store ───────────────────────────────────────────────────────────────────

export interface LocalScoutState {
  runs: Array<{ run: ScoutRun; totals?: ScoutRunTotals; metrics?: ScoutRunMetrics }>;
  probes: Record<string, ScoutProbeRecord[]>;
  findings: ScoutFinding[];
  tasks: Array<{ id: string; status: string; input: ScoutFollowUpTaskInput; refreshes: number; held?: boolean; retiredByScout?: boolean }>;
}

/** Every write the action policy made. Shadow must leave this empty. */
export interface ScoutWriteAudit {
  op: 'raiseActionState' | 'insertTask' | 'claimFollowUp' | 'releaseHold' | 'deleteTask' | 'refreshTask' | 'announce' | 'retireFollowUp' | 'dismissFinding';
  detail: string;
}

const RANK: Record<ScoutActionState, number> = { none: 0, retained: 1, aggregated: 2, proposed: 3, filed: 4 };

/** Product-side writes: the ones a shadow run must never make. Raising a finding's action state is ledger bookkeeping. */
export const PRODUCT_WRITE_OPS: ReadonlySet<ScoutWriteAudit['op']> = new Set(['insertTask', 'claimFollowUp', 'releaseHold', 'deleteTask', 'refreshTask', 'announce', 'retireFollowUp', 'dismissFinding']);

export function localScoutStore(path?: string) {
  const state: LocalScoutState =
    path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { runs: [], probes: {}, findings: [], tasks: [] };
  const audit: ScoutWriteAudit[] = [];
  const persist = () => { if (path) writeFileSync(path, JSON.stringify(state, null, 2)); };
  const findingOf = (sig: string) => state.findings.find((f) => f.signature === sig);
  const setFinding = (f: ScoutFinding) => {
    const i = state.findings.findIndex((x) => x.signature === f.signature);
    if (i >= 0) state.findings[i] = f;
    else state.findings.push(f);
    persist();
  };

  const findings: ScoutFindingStore = {
    find: async (_w, s) => findingOf(s) ?? null,
    insert: async (f) => (findingOf(f.signature) ? false : (setFinding(f), true)),
    update: async (f, expected) => {
      const cur = findingOf(f.signature);
      if (cur?.occurrenceCount !== expected) return false;
      // Same as the DB compare-and-set: a stale open read cannot un-dismiss.
      if (cur.state === 'dismissed' && f.state !== 'dismissed') return false;
      // The ledger never writes the action or dismissal columns.
      setFinding({
        ...f,
        actionState: cur.actionState,
        actionTaskId: cur.actionTaskId,
        dismissedReason: cur.dismissedReason ?? null,
        dismissedAt: cur.dismissedAt ?? null,
        dismissedBy: cur.dismissedBy ?? null,
      });
      return true;
    },
  };

  const ledger: ScoutRunLedger = {
    async latestRun(_ws, ref) {
      const last = state.runs.filter((r) => r.run.candidate.ref === ref && r.run.status === 'completed').at(-1);
      return last ? { id: last.run.id, sha: last.run.candidate.sha } : null;
    },
    async claimRun(run, staleBefore) {
      const i = state.runs.findIndex((r) => r.run.id === run.id);
      const cur = state.runs[i];
      if (cur && !(cur.run.status === 'failed' || (cur.run.status === 'running' && Date.parse(cur.run.startedAt) < staleBefore.getTime()))) {
        return 'duplicate';
      }
      if (i >= 0) state.runs.splice(i, 1);
      state.runs.push({ run });
      persist();
      return 'claimed';
    },
    async saveRun(run, totals, metrics) {
      const i = state.runs.findIndex((r) => r.run.id === run.id);
      const row = { run, totals, metrics };
      if (i >= 0) state.runs[i] = row;
      else state.runs.push(row);
      persist();
    },
    async saveProbes(run, ps) {
      state.probes[run.id] = [...ps];
      persist();
    },
    findings,
    async resolveForPass(run, p) {
      const resolved: Array<{ signature: string; actionTaskId: string | null }> = [];
      for (const f of state.findings) {
        if (f.checkId === p.result?.checkId && f.state === 'open') {
          setFinding({ ...f, state: 'resolved', resolvedRunId: run.id, resolvedSha: run.candidate.sha, resolvedAt: new Date().toISOString() });
          resolved.push({ signature: f.signature, actionTaskId: f.actionTaskId });
        }
      }
      return resolved;
    },
  };

  let n = state.tasks.length;
  const actions: ScoutActionStore = {
    async raiseActionState(_w, sig, to) {
      const f = findingOf(sig);
      if (!f || f.state !== 'open' || RANK[f.actionState] >= RANK[to]) return false;
      audit.push({ op: 'raiseActionState', detail: `${sig.slice(0, 12)} → ${to}` });
      setFinding({ ...f, actionState: to });
      return true;
    },
    taskStatus: async (id) => state.tasks.find((t) => t.id === id)?.status ?? null,
    cancelledByScout: async (id) => state.tasks.find((t) => t.id === id)?.retiredByScout === true,
    async insertTask(input) {
      const id = `local-task-${++n}`;
      audit.push({ op: 'insertTask', detail: `${id} ${input.title}` });
      state.tasks.push({ id, status: 'pending', input, refreshes: 0, held: true });
      persist();
      return { id };
    },
    async claimFollowUp(_w, sig, id, takeover) {
      const f = findingOf(sig);
      audit.push({ op: 'claimFollowUp', detail: `${sig.slice(0, 12)} → ${id}` });
      if (!f || f.state !== 'open' || (f.actionTaskId && !takeover.includes(f.actionTaskId))) return false;
      setFinding({ ...f, actionState: 'filed', actionTaskId: id });
      return true;
    },
    async releaseHold(id) {
      audit.push({ op: 'releaseHold', detail: id });
      const t = state.tasks.find((x) => x.id === id);
      if (t) t.held = false;
      persist();
    },
    currentTaskId: async (_w, sig) => findingOf(sig)?.actionTaskId ?? null,
    async deleteTask(id) {
      audit.push({ op: 'deleteTask', detail: id });
      state.tasks = state.tasks.filter((t) => t.id !== id);
      persist();
    },
    async refreshTask(id) {
      audit.push({ op: 'refreshTask', detail: id });
      const t = state.tasks.find((x) => x.id === id);
      if (t) {
        t.refreshes++;
        t.held = false;
      }
      persist();
      return !!t;
    },
    async announce(id) {
      audit.push({ op: 'announce', detail: id });
    },
    async retireFollowUp(id) {
      const t = state.tasks.find((x) => x.id === id);
      if (!t || isTerminalTaskStatus(t.status)) return null;
      const outcome = t.status === 'pending' ? 'cancelled' : 'annotated';
      audit.push({ op: 'retireFollowUp', detail: `${id} ${outcome}` });
      if (outcome === 'cancelled') {
        t.status = 'cancelled';
        t.retiredByScout = true;
      }
      persist();
      return outcome;
    },
    async dismissFinding(_w, sig, fields) {
      const f = findingOf(sig);
      if (!f) return { dismissed: false, exists: false };
      if (f.state === 'dismissed') return { dismissed: false, exists: true };
      audit.push({ op: 'dismissFinding', detail: `${sig.slice(0, 12)} by ${fields.dismissedBy}` });
      setFinding({ ...f, state: 'dismissed', dismissedReason: fields.dismissedReason, dismissedBy: fields.dismissedBy, dismissedAt: fields.dismissedAt.toISOString() });
      return { dismissed: true, actionTaskId: f.actionTaskId };
    },
  };

  return { state, audit, ledger, actions, productWrites: () => audit.filter((a) => PRODUCT_WRITE_OPS.has(a.op)) };
}
