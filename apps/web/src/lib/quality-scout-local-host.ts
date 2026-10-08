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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { exec } from '@buildd/core/quality-scout/local-host';
import { computeReadiness, type ReadinessReport } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import { SCOUT_PROBE_SELECTION_CONFIG } from '@buildd/core/decision-kind-scout-probe-selection';
import type { ScoutFindingStore } from '@buildd/core/quality-scout/ledger';
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

// ── git + command port (shared with the runner: @buildd/core/quality-scout/local-host) ──

export {
  exec,
  gitChangedPaths,
  gitHead,
  gitStatus,
  localCommandPort,
  type Exec,
  type LocalCommandPortOptions,
  type LocalCommandRecord,
} from '@buildd/core/quality-scout/local-host';

async function git(dir: string, args: string[]): Promise<string> {
  const r = await exec('git', args, { cwd: dir, timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim().slice(0, 200)}`);
  return r.stdout;
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
