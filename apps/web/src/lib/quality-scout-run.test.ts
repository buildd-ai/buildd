import { describe, expect, it } from 'bun:test';
import { computeReadiness } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities } from '@buildd/core/scout-capabilities';
import type { ScoutFindingStore } from '@buildd/core/quality-scout/ledger';
import { SCOUT_VIEWPORTS, type ScoutCommandOutput, type ScoutCommandRequest, type ScoutProbePorts } from '@buildd/core/quality-scout/executors';
import type { ScoutProbeDecider } from '@buildd/core/quality-scout/selector';
import type {
  ScoutActionState,
  ScoutFinding,
  ScoutHostNeed,
  ScoutProbeRecord,
  ScoutRun,
  ScoutRunMetrics,
  ScoutRunTotals,
} from '@buildd/core/quality-scout/types';
import type { ScoutActionStore, ScoutFollowUpTaskInput } from './quality-scout-actions';
import {
  assignScoutHosts,
  executeScoutProbes,
  finalizeExpiredScoutRun,
  finalizeScoutRun,
  MAX_SCOUT_CAPTURE_RUNNER_DURATION_MS,
  mergeScoutExecution,
  parkScoutRun,
  planScoutRun,
  SCOUT_CAPTURE_MS_PER_VIEWPORT,
  SCOUT_LEASE_SLACK_MS,
  scoutRunnerDuration,
  runQualityScout,
  scoutHostNeed,
  scoutRunId,
  type ScoutRunDeps,
  type ScoutRunLedger,
  type ScoutRunRequest,
} from './quality-scout-run';

const SHA = 'c'.repeat(40);
const HEAD2 = 'd'.repeat(40);
const T0 = new Date('2026-10-05T10:00:00Z');

/** A Python CLI: nothing Buildd-shaped. */
const profile = discoverScoutCapabilities({
  readiness: computeReadiness({
    files: ['pyproject.toml', 'uv.lock', 'src/tool/__init__.py', 'src/tool/cli.py', 'tests/test_cli.py'],
    manifests: { 'pyproject.toml': '[project]\nname = "tool"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
  }),
  extension: {
    journeys: [{ name: 'help', kind: 'cli', command: 'uv run tool --help', mutates: false, expect: 'exit 0 and stdout contains Usage' }],
  },
});

/** Grounded in a change, a recurring failure and an owner-declared critical path. */
const SIGNALS = {
  candidateRef: 'main',
  changedPaths: ['src/tool/cli.py', 'src/tool/report.py'],
  failures: [{ signature: 'cli-crash-on-empty-input', count: 3, paths: ['src/tool/cli.py'] }],
  criticalPaths: [{ name: 'report', pattern: 'src/tool/report.py', severity: 'critical' as const }],
};

/** Changes across several areas: enough candidates that selection asks more than one decision. */
const WIDE_SIGNALS = {
  ...SIGNALS,
  changedPaths: ['src/tool/cli.py', 'src/tool/report.py', 'src/tool/export.py', 'src/tool/parse.py', 'tests/test_cli.py', 'pyproject.toml'],
};
const wideProfile = discoverScoutCapabilities({
  readiness: computeReadiness({
    files: ['pyproject.toml', 'uv.lock', 'src/tool/__init__.py', 'src/tool/cli.py', 'tests/test_cli.py'],
    manifests: { 'pyproject.toml': '[project]\nname = "tool"\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n' },
  }),
  extension: {
    journeys: ['help', 'version', 'list', 'export', 'parse'].map((name) => ({ name, kind: 'cli' as const, command: `uv run tool ${name}`, mutates: false, expect: 'exit 0' })),
  },
});

const runAll: ScoutProbeDecider = async () => ({ decision: 'run', reasonCode: 'test', source: 'rule' });

function commandPort(out: Partial<ScoutCommandOutput> = {}) {
  const calls: ScoutCommandRequest[] = [];
  return {
    calls,
    port: {
      async run(req: ScoutCommandRequest): Promise<ScoutCommandOutput> {
        calls.push(req);
        return { exitCode: 2, timedOut: false, stdoutTail: 'nope', evidenceRef: `log:${calls.length}`, ...out };
      },
    },
  };
}

interface Saved { run: ScoutRun; totals?: ScoutRunTotals; metrics?: ScoutRunMetrics }

function memoryWorld() {
  const runs = new Map<string, Saved>();
  const probes = new Map<string, ScoutProbeRecord[]>();
  const findings = new Map<string, ScoutFinding>();
  const tasks = new Map<string, { status: string; input: ScoutFollowUpTaskInput }>();
  const resolved: string[] = [];
  let n = 0;
  const findingStore: ScoutFindingStore = {
    find: async (_w, s) => findings.get(s) ?? null,
    insert: async (f) => (findings.has(f.signature) ? false : (findings.set(f.signature, f), true)),
    update: async (f, c) => {
      const cur = findings.get(f.signature);
      if (cur?.occurrenceCount !== c) return false;
      // The ledger never writes the action columns.
      findings.set(f.signature, { ...f, actionState: cur.actionState, actionTaskId: cur.actionTaskId });
      return true;
    },
  };
  const ledger: ScoutRunLedger = {
    async latestRun(_ws, ref) {
      const done = [...runs.values()].filter((s) => s.run.candidate.ref === ref && s.run.status === 'completed');
      const last = done.at(-1);
      return last ? { id: last.run.id, sha: last.run.candidate.sha } : null;
    },
    async claimRun(run, staleBefore) {
      const cur = runs.get(run.id);
      if (cur && !(cur.run.status === 'failed' || (cur.run.status === 'running' && Date.parse(cur.run.startedAt) < staleBefore.getTime()))) {
        return 'duplicate';
      }
      runs.set(run.id, { run });
      return 'claimed';
    },
    async saveRun(run, totals, metrics) {
      runs.set(run.id, { run, totals, metrics });
    },
    async saveProbes(run, ps) {
      probes.set(run.id, [...ps]);
    },
    findings: findingStore,
    async resolveForPass(run, p) {
      resolved.push(p.candidateId);
      const out: Array<{ signature: string; actionTaskId: string | null }> = [];
      for (const [sig, f] of findings) {
        if (f.checkId !== p.result?.checkId || f.state !== 'open') continue;
        findings.set(sig, { ...f, state: 'resolved', resolvedRunId: run.id, resolvedSha: run.candidate.sha });
        out.push({ signature: sig, actionTaskId: f.actionTaskId });
      }
      return out;
    },
  };
  const RANK: Record<ScoutActionState, number> = { none: 0, retained: 1, aggregated: 2, proposed: 3, filed: 4 };
  const actions: ScoutActionStore = {
    async raiseActionState(_w, sig, to) {
      const f = findings.get(sig)!;
      if (RANK[f.actionState] >= RANK[to]) return false;
      findings.set(sig, { ...f, actionState: to });
      return true;
    },
    taskStatus: async (id) => tasks.get(id)?.status ?? null,
    cancelledByScout: async () => true,
    releaseHold: async () => {},
    async dismissFinding(_w, sig, fields) {
      const f = findings.get(sig);
      if (!f) return { dismissed: false, exists: false };
      if (f.state === 'dismissed') return { dismissed: false, exists: true };
      findings.set(sig, { ...f, state: 'dismissed', dismissedReason: fields.dismissedReason, dismissedBy: fields.dismissedBy, dismissedAt: fields.dismissedAt.toISOString() });
      return { dismissed: true, actionTaskId: f.actionTaskId };
    },
    async insertTask(input) {
      const id = `task-${++n}`;
      tasks.set(id, { status: 'pending', input });
      return { id };
    },
    async claimFollowUp(_w, sig, id, takeover) {
      const f = findings.get(sig)!;
      if (f.actionTaskId && !takeover.includes(f.actionTaskId)) return false;
      findings.set(sig, { ...f, actionState: 'filed', actionTaskId: id });
      return true;
    },
    currentTaskId: async (_w, sig) => findings.get(sig)?.actionTaskId ?? null,
    async deleteTask(id) {
      tasks.delete(id);
    },
    refreshTask: async () => true,
    announce: async () => {},
    async retireFollowUp(id) {
      const t = tasks.get(id);
      if (!t || ['completed', 'failed', 'cancelled'].includes(t.status)) return null;
      if (t.status !== 'pending') return 'annotated';
      t.status = 'cancelled';
      return 'cancelled';
    },
  };
  return { runs, probes, findings, tasks, resolved, ledger, actions };
}

function deps(world: ReturnType<typeof memoryWorld>, over: Partial<ScoutRunDeps> = {}): ScoutRunDeps {
  return {
    now: () => T0,
    loadProfile: async () => profile,
    gatherSignals: async () => SIGNALS,
    decide: runAll,
    ports: { command: commandPort().port },
    ledger: world.ledger,
    actions: world.actions,
    headSha: async () => SHA,
    ...over,
  };
}

const request = (over: Partial<ScoutRunRequest> = {}): ScoutRunRequest => ({
  workspaceId: 'ws-1',
  trigger: 'mission-candidate',
  mode: 'propose',
  candidate: { ref: 'main', sha: SHA },
  ...over,
});

describe('runQualityScout — modes', () => {
  it('off does nothing at all', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request({ mode: 'off' }), deps(w));
    expect(out).toMatchObject({ status: 'skipped', reason: 'mode_off' });
    expect(w.runs.size).toBe(0);
  });

  it('propose records findings and files one deduped follow-up', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w));
    expect(out.status).toBe('completed');
    expect(w.findings.size).toBeGreaterThan(0);
    expect(w.tasks.size).toBe(w.findings.size);
    if (out.status !== 'completed') throw new Error('not completed');
    expect(out.metrics.actions.filed).toBe(w.tasks.size);
    expect(out.metrics.actionable).toBe(w.tasks.size);
  });

  it('shadow writes findings but never a task', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request({ mode: 'shadow' }), deps(w));
    expect(out.status).toBe('completed');
    expect(w.findings.size).toBeGreaterThan(0);
    expect(w.tasks.size).toBe(0);
    expect([...w.findings.values()].every((f) => f.actionState === 'proposed' || f.actionState === 'aggregated')).toBe(true);
  });
});

describe('runQualityScout — dedupe', () => {
  it('a repeated identical failure on a newer SHA updates the finding and files nothing new', async () => {
    const w = memoryWorld();
    await runQualityScout(request(), deps(w));
    const tasksAfterFirst = w.tasks.size;
    const out = await runQualityScout(request({ candidate: { ref: 'main', sha: HEAD2 } }), deps(w, { headSha: async () => HEAD2 }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(w.tasks.size).toBe(tasksAfterFirst);
    expect([...w.findings.values()].every((f) => f.occurrenceCount === 2)).toBe(true);
    expect(out.metrics.dedupeSuppressed).toBe(tasksAfterFirst);
    expect(out.metrics.prior).toMatchObject({ sha: SHA });
  });

  it('an automatic trigger on an already-exercised SHA is skipped as a duplicate', async () => {
    const w = memoryWorld();
    await runQualityScout(request(), deps(w));
    const again = await runQualityScout(request({ trigger: 'periodic' }), deps(w));
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  });

  it('the run id is stable per workspace + SHA for automatic triggers, and per dedupe key for manual runs', () => {
    expect(scoutRunId('ws', 'periodic', SHA)).toBe(scoutRunId('ws', 'mission-candidate', SHA));
    expect(scoutRunId('ws', 'manual', SHA, 'a')).not.toBe(scoutRunId('ws', 'manual', SHA, 'b'));
    expect(scoutRunId('ws', 'manual', SHA, 'a')).not.toBe(scoutRunId('ws', 'periodic', SHA));
    expect(scoutRunId('ws', 'periodic', SHA)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});

describe('runQualityScout — inconclusive and unsupported never file', () => {
  it('a probe with no host port is unsupported and creates no finding or task', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { ports: {} }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.verdicts.fail).toBe(0);
    expect(out.metrics.verdicts.unsupported + out.metrics.verdicts.inconclusive).toBe(out.metrics.probesSelected);
    expect(w.findings.size).toBe(0);
    expect(w.tasks.size).toBe(0);
  });

  it('a pass resolves rather than files', async () => {
    const w = memoryWorld();
    const ports: ScoutProbePorts = { command: commandPort({ exitCode: 0, stdoutTail: 'Usage: tool' }).port };
    const out = await runQualityScout(request(), deps(w, { ports }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(w.tasks.size).toBe(0);
    expect(w.resolved.length).toBe(out.metrics.verdicts.pass);
  });
});

describe('runQualityScout — a resolved finding retires its follow-up', () => {
  const passing: ScoutProbePorts = { command: commandPort({ exitCode: 0, stdoutTail: 'Usage: tool' }).port };

  it('fail → file → pass: the still-pending follow-up is cancelled, not left owed', async () => {
    const w = memoryWorld();
    await runQualityScout(request(), deps(w));
    const filed = [...w.findings.values()].map((f) => f.actionTaskId!);
    expect(filed.length).toBeGreaterThan(0);
    expect(filed.every((id) => w.tasks.get(id)?.status === 'pending')).toBe(true);

    const out = await runQualityScout(request({ candidate: { ref: 'main', sha: HEAD2 } }), deps(w, { ports: passing, headSha: async () => HEAD2 }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect([...w.findings.values()].every((f) => f.state === 'resolved')).toBe(true);
    expect(filed.every((id) => w.tasks.get(id)?.status === 'cancelled')).toBe(true);
    expect(out.metrics.findings.resolved).toBe(filed.length);
    expect(out.metrics.actions.cancelled).toBe(filed.length);
  });

  it('a claimed follow-up is annotated for its worker, not cancelled out from under it', async () => {
    const w = memoryWorld();
    await runQualityScout(request(), deps(w));
    for (const t of w.tasks.values()) t.status = 'in_progress';
    const out = await runQualityScout(request({ candidate: { ref: 'main', sha: HEAD2 } }), deps(w, { ports: passing, headSha: async () => HEAD2 }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect([...w.tasks.values()].every((t) => t.status === 'in_progress')).toBe(true);
    expect(out.metrics.actions.annotated).toBe(w.tasks.size);
    expect(out.metrics.actions.cancelled).toBe(0);
  });

  it('a retire error is counted as failed and the run still completes', async () => {
    const w = memoryWorld();
    await runQualityScout(request(), deps(w));
    w.actions.retireFollowUp = async () => { throw new Error('db down'); };
    const out = await runQualityScout(request({ candidate: { ref: 'main', sha: HEAD2 } }), deps(w, { ports: passing, headSha: async () => HEAD2 }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.actions.failed).toBe(w.tasks.size);
  });
});

describe('runQualityScout — bounded and fail-open', () => {
  it('a time bound cuts execution short; unrun probes are inconclusive, not dropped', async () => {
    const w = memoryWorld();
    let t = T0.getTime();
    const slow: ScoutProbePorts = {
      command: {
        async run() {
          t += 60_000;
          return { exitCode: 2, timedOut: false, evidenceRef: 'log:1' };
        },
      },
    };
    const out = await runQualityScout(request({ maxDurationMs: 30_000 }), deps(w, { ports: slow, now: () => new Date(t) }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.probesSelected).toBeGreaterThan(1);
    expect(out.metrics.deadlineHit).toBe(true);
    expect(out.metrics.probesRun).toBe(1);
    expect(out.metrics.probesNotExecuted).toBe(out.metrics.probesSelected - 1);
    expect(out.metrics.verdicts.total).toBe(out.metrics.probesSelected);
  });

  it('a throwing profile fails the run, records it, and never throws', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { loadProfile: async () => { throw new Error('github down'); } }));
    expect(out).toMatchObject({ status: 'failed' });
    const saved = [...w.runs.values()][0];
    expect(saved.run.status).toBe('failed');
    expect(saved.run.error).toContain('github down');
  });

  it('a failed signal gather degrades to no change signals instead of failing', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { gatherSignals: async () => { throw new Error('compare failed'); } }));
    expect(out.status).toBe('completed');
    if (out.status === 'completed') expect(out.metrics.warnings.join(' ')).toContain('signals');
  });

  it('a failed action store does not fail the run', async () => {
    const w = memoryWorld();
    w.actions.insertTask = async () => { throw new Error('db down'); };
    const out = await runQualityScout(request(), deps(w));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.actions.failed).toBeGreaterThan(0);
  });

  it('a ledger claim error is reported, not thrown', async () => {
    const w = memoryWorld();
    w.ledger.claimRun = async () => { throw new Error('db down'); };
    expect(await runQualityScout(request(), deps(w))).toMatchObject({ status: 'failed' });
  });
});

describe('runQualityScout — readout metrics', () => {
  it('records candidates, selection, stage timings, verdicts, exercised SHA and staleness', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { headSha: async () => HEAD2 }));
    if (out.status !== 'completed') throw new Error(out.status);
    const m = out.metrics;
    expect(m.candidatesGenerated).toBeGreaterThan(0);
    expect(m.probesSelected).toBeGreaterThan(0);
    expect(m.probesSelected).toBeLessThanOrEqual(4);
    expect(m.exercised).toEqual({ ref: 'main', sha: SHA });
    expect(m.headSha).toBe(HEAD2);
    expect(m.staleness).toBe('stale');
    expect(Object.keys(m.stages).sort()).toEqual(['act', 'execute', 'generate', 'profile', 'select', 'signals']);
    const saved = w.runs.get(out.runId)!;
    expect(saved.run.status).toBe('completed');
    expect(saved.metrics).toEqual(m);
    expect(saved.totals?.candidatesGenerated).toBe(m.candidatesGenerated);
    // Contract before execution: every candidate has a probe row.
    expect(w.probes.get(out.runId)!.length).toBe(m.candidatesGenerated);
  });

  it('the selection stage carries the decision cost the decider reported', async () => {
    const w = memoryWorld();
    let cost = 0;
    const decide: ScoutProbeDecider = async () => {
      cost += 0.001;
      return { decision: 'run', reasonCode: 'test', source: 'model' };
    };
    const out = await runQualityScout(request(), deps(w, { decide, takeDecisionCost: () => cost }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.stages.select.costUsd).toBeCloseTo(cost, 6);
    expect(out.metrics.costUsd).toBeCloseTo(cost, 6);
  });

  it('budget.maxCostUsd caps the selection model: no decision call is made that would pass it', async () => {
    const w = memoryWorld();
    let cost = 0;
    let calls = 0;
    const decide: ScoutProbeDecider = async () => {
      calls++;
      cost += 0.001;
      return { decision: 'defer', reasonCode: 'test', source: 'model' };
    };
    // Uncapped, this world asks several decisions; capped, only the first fits.
    const uncapped = await runQualityScout(request({ budget: { maxProbes: 10 }, dedupeKey: 'uncapped', trigger: 'manual' }), deps(memoryWorld(), { decide, gatherSignals: async () => WIDE_SIGNALS, loadProfile: async () => wideProfile, takeDecisionCost: () => cost }));
    if (uncapped.status !== 'completed') throw new Error(uncapped.status);
    expect(uncapped.metrics.decisionsAsked).toBeGreaterThan(1);
    cost = 0;
    calls = 0;
    const out = await runQualityScout(request({ budget: { maxProbes: 10, maxCostUsd: 0.0015 } }), deps(w, { decide, gatherSignals: async () => WIDE_SIGNALS, loadProfile: async () => wideProfile, takeDecisionCost: () => cost }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(calls).toBe(1);
    expect(out.metrics.costUsd).toBeLessThanOrEqual(0.0015);
    expect(out.metrics.costCapHit).toBe(true);
    expect(out.metrics.decisionsAsked).toBe(1);
    expect(out.metrics.warnings.some((x) => x.includes('cost cap'))).toBe(true);
  });

  it('reaching the cost cap does not withhold probe execution, which has no model cost', async () => {
    const w = memoryWorld();
    let cost = 0;
    const decide: ScoutProbeDecider = async () => {
      cost += 0.001;
      return { decision: 'run', reasonCode: 'test', source: 'model' };
    };
    const out = await runQualityScout(request({ budget: { maxCostUsd: 0.001 } }), deps(w, { decide, takeDecisionCost: () => cost }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.probesSelected).toBeGreaterThan(0);
    expect(out.metrics.probesNotExecuted).toBe(0);
    expect(out.metrics.deadlineHit).toBe(false);
  });

  it('an absent cap records costCapHit false and bounds selection by the decision limit alone', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { takeDecisionCost: () => 0 }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.costCapHit).toBe(false);
  });
});

// ── Split pipeline and runner hosts ─────────────────────────────────────────

const THIRTY_MIN = 30 * 60_000;
/** The server host: readiness only, no command port — production's shape. */
const serverPorts = (): ScoutProbePorts => ({
  readiness: {
    async read({ sha }) {
      return { report: computeReadiness({ files: ['pyproject.toml'], manifests: {} }), evidenceRef: `readiness@${sha}` };
    },
  },
});
const runnerOffers = (...needs: ScoutHostNeed[]) => async () => new Set<ScoutHostNeed>(needs);

describe('the split legs compose to exactly what runQualityScout does', () => {
  it('plan → execute → finalize gives the same metrics, probes and findings as one runQualityScout call', async () => {
    const a = memoryWorld();
    const whole = await runQualityScout(request(), deps(a));
    if (whole.status !== 'completed') throw new Error(whole.status);

    const b = memoryWorld();
    const d = deps(b);
    const planned = await planScoutRun(request(), d);
    if (planned.status !== 'planned') throw new Error(planned.status);
    const { plan } = planned;
    expect(plan.hosted).toBe(false);
    // Contracts are frozen before anything executes.
    expect(b.probes.get(plan.run.id)!.every((p) => p.result === null)).toBe(true);
    expect(plan.records.every((p) => p.host === undefined)).toBe(true);
    const ex = await executeScoutProbes(plan.run, plan.records, plan.profile, d.ports, { now: d.now, startedAt: plan.startedAt, maxDurationMs: plan.maxDurationMs });
    mergeScoutExecution(plan, ex);
    const split = await finalizeScoutRun({ run: plan.run, records: plan.records, summary: plan.summary, mode: 'propose' }, d);
    if (split.status !== 'completed') throw new Error(split.status);

    expect(split.metrics).toEqual(whole.metrics);
    expect(b.probes.get(split.runId)).toEqual(a.probes.get(whole.runId));
    expect([...b.findings.keys()].sort()).toEqual([...a.findings.keys()].sort());
    expect(b.tasks.size).toBe(a.tasks.size);
  });

  it('execute runs only the probes of the host it is given, and leaves a probe with a result alone', async () => {
    const w = memoryWorld();
    const cmd = commandPort();
    const d = deps(w, { ports: { ...serverPorts(), command: cmd.port }, runnerHost: runnerOffers('command') });
    const planned = await planScoutRun(request(), d);
    if (planned.status !== 'planned') throw new Error(planned.status);
    // With a command port on this host, nothing needs the runner.
    expect(planned.plan.records.filter((p) => p.host === 'runner')).toEqual([]);

    const forced = planned.plan.records.map((p) => (p.selection.status === 'selected' ? { ...p, host: 'runner' as const } : p));
    const bounds = { now: d.now, startedAt: planned.plan.startedAt, maxDurationMs: planned.plan.maxDurationMs };
    const onServer = await executeScoutProbes(planned.plan.run, forced, planned.plan.profile, d.ports, { ...bounds, host: 'server' });
    expect(cmd.calls.length).toBe(0);
    expect(onServer.records.every((p) => p.result === null)).toBe(true);
    const onRunner = await executeScoutProbes(planned.plan.run, forced, planned.plan.profile, d.ports, { ...bounds, host: 'runner' });
    expect(cmd.calls.length).toBeGreaterThan(0);
    expect(onRunner.records.filter((p) => p.selection.status === 'selected').every((p) => p.result && p.host === 'runner')).toBe(true);
    const again = await executeScoutProbes(planned.plan.run, onRunner.records, planned.plan.profile, d.ports, { ...bounds, host: 'runner' });
    expect(again.records).toEqual(onRunner.records);
  });
});

describe('host assignment', () => {
  it('a command probe is the runner\'s when a runner offers command and the server does not', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { ports: serverPorts(), runnerHost: runnerOffers('command') }));
    expect(out.status).toBe('awaiting_host');
    const saved = w.probes.get(out.runId!)!;
    const runner = saved.filter((p) => p.host === 'runner');
    expect(runner.length).toBeGreaterThan(0);
    // Parked, not judged: nothing ran them and nothing guessed a verdict.
    expect(runner.every((p) => p.result === null)).toBe(true);
    expect(saved.filter((p) => p.selection.status === 'selected').every((p) => p.host === 'runner' || p.host === 'server')).toBe(true);
    // Nothing is filed while the run is parked.
    expect(w.findings.size).toBe(0);
    expect(w.tasks.size).toBe(0);
  });

  it('with no runner, candidates only a runner could run are skipped no_host before selection, and the run never parks', async () => {
    const w = memoryWorld();
    let asked = 0;
    const decide: ScoutProbeDecider = async () => { asked++; return { decision: 'run', reasonCode: 'test', source: 'rule' }; };
    const out = await runQualityScout(request(), deps(w, { ports: serverPorts(), runnerHost: async () => null, decide }));
    if (out.status !== 'completed') throw new Error(out.status);
    const saved = w.probes.get(out.runId)!;
    const noHost = saved.filter((p) => p.selection.status === 'skipped' && p.selection.reason === 'no_host');
    expect(noHost.length).toBeGreaterThan(0);
    expect(noHost.every((p) => p.selection.status === 'skipped' && p.selection.reasonCode === 'no_runner_host')).toBe(true);
    // No budget slot went to a command probe.
    expect(saved.filter((p) => p.selection.status === 'selected').some((p) => p.executor && scoutHostNeed(p.executor, profile) === 'command')).toBe(false);
    expect(w.runs.get(out.runId)!.run.parking ?? null).toBeNull();
    expect(w.findings.size).toBe(0);
    expect(asked).toBeLessThanOrEqual(out.metrics.decisionsAsked);
  });

  it('a runner that cannot be read is treated as no runner, with a warning', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w, { ports: serverPorts(), runnerHost: async () => { throw new Error('db down'); } }));
    if (out.status !== 'completed') throw new Error(out.status);
    expect(out.metrics.warnings.some((x) => x.includes('runner availability'))).toBe(true);
  });

  it('scoutHostNeed maps capabilities to what their host must offer', () => {
    expect(scoutHostNeed(null, profile)).toBeNull();
    expect(scoutHostNeed('cli-journey:help', profile)).toBe('command');
    expect(scoutHostNeed('ui-surface', profile)).toBe('capture');
    expect(scoutHostNeed('release', profile)).toBe('readiness');
    expect(scoutHostNeed('spec', profile)).toBe('spec');
    expect(scoutHostNeed('not-a-kind', profile)).toBeNull();
  });

  it('assignScoutHosts never sends a server-hostable probe to a runner', () => {
    const rec = (executor: string, selected = true): ScoutProbeRecord => ({
      candidateId: executor, family: 'contract', probeKind: 'regression', title: 't', invariant: 'i', sourceSignals: [], preconditions: [],
      executor, estimatedCost: 'low', risk: 'medium', mutates: false, evidenceRequirements: [], unsupportedReason: null,
      selection: selected ? { status: 'selected', via: 'decision', reasonCode: 'x', decisionSource: null } : { status: 'skipped', reason: 'deferred', reasonCode: null },
      result: null,
    });
    const out = assignScoutHosts([rec('cli-journey:help'), rec('release'), rec('cli-journey:x', false)], profile, new Set(['readiness', 'http']), new Set(['command', 'readiness']));
    expect(out.map((p) => p.host)).toEqual(['runner', 'server', undefined]);
    const noRunner = assignScoutHosts([rec('cli-journey:help')], profile, new Set(['readiness']), new Set());
    expect(noRunner[0].host).toBe('server');
  });
});

describe('a parked run', () => {
  async function parked(w = memoryWorld(), over: Partial<ScoutRunRequest> = {}) {
    const out = await runQualityScout(request(over), deps(w, { ports: serverPorts(), runnerHost: runnerOffers('command') }));
    if (out.status !== 'awaiting_host') throw new Error(out.status);
    return { w, out, saved: w.runs.get(out.runId)!.run };
  }

  it('is saved awaiting_host with a frozen profile, the candidate, a deadline, its runner bound and an empty lease', async () => {
    const { out, saved } = await parked();
    expect(saved.status).toBe('awaiting_host');
    expect(saved.candidate).toEqual({ ref: 'main', sha: SHA });
    expect(saved.parking!.profile).toEqual(profile);
    expect(saved.parking!.lease).toBeNull();
    expect(saved.parking!.leaseLapses).toBe(0);
    expect(saved.parking!.runnerMaxDurationMs).toBe(20 * 60_000);
    expect(saved.parking!.hostDeadline).toBe(new Date(T0.getTime() + THIRTY_MIN).toISOString());
    expect(out.hostDeadline).toBe(saved.parking!.hostDeadline);
    expect(out.runnerProbes).toBeGreaterThan(0);
  });

  it('caps the runner bound at an hour and never sets a deadline that cuts a held lease short', async () => {
    const { saved } = await parked(memoryWorld(), { host: { runnerMaxDurationMs: 5 * 3_600_000, hostDeadlineMs: 60_000 } });
    expect(saved.parking!.runnerMaxDurationMs).toBe(60 * 60_000);
    expect(Date.parse(saved.parking!.hostDeadline) - T0.getTime()).toBe(65 * 60_000);
  });

  /** Park a planned run whose records gain `n` runner-hosted surface probes (two viewports each). */
  async function parkedWithCapture(n: number, host: ScoutRunRequest['host'] = {}) {
    const w = memoryWorld();
    const req = request({ host });
    const d = deps(w, { ports: serverPorts(), runnerHost: runnerOffers('command') });
    const planned = await planScoutRun(req, d);
    if (planned.status !== 'planned') throw new Error(planned.status);
    const surface = (i: number): ScoutProbeRecord => ({
      candidateId: `surface-${i}`, family: 'surface', probeKind: 'regression', title: 't', invariant: 'i', sourceSignals: [], preconditions: [],
      executor: 'ui-surface', estimatedCost: 'high', risk: 'medium', mutates: false, evidenceRequirements: [], unsupportedReason: null,
      selection: { status: 'selected', via: 'decision', reasonCode: 'x', decisionSource: null }, host: 'runner', result: null,
    });
    const plan = { ...planned.plan, records: [...planned.plan.records, ...Array.from({ length: n }, (_, i) => surface(i))] };
    const out = await parkScoutRun(plan, req, d);
    if (out.status !== 'awaiting_host') throw new Error(out.status);
    return w.runs.get(out.runId)!.run.parking!;
  }

  it('with a two-viewport surface probe, defaults to a lease longer than the capture estimate', async () => {
    const parking = await parkedWithCapture(1);
    const estimate = SCOUT_VIEWPORTS.length * SCOUT_CAPTURE_MS_PER_VIEWPORT;
    expect(parking.runnerMaxDurationMs).toBeGreaterThanOrEqual(estimate);
    expect(parking.runnerMaxDurationMs + SCOUT_LEASE_SLACK_MS).toBeGreaterThan(estimate);
    // The host deadline still never cuts the lease short.
    expect(Date.parse(parking.hostDeadline) - T0.getTime()).toBeGreaterThanOrEqual(parking.runnerMaxDurationMs + SCOUT_LEASE_SLACK_MS);
  });

  it('a capture-aware lease ends before the hour a GitHub installation token lives', async () => {
    const parking = await parkedWithCapture(3);
    expect(parking.runnerMaxDurationMs).toBe(MAX_SCOUT_CAPTURE_RUNNER_DURATION_MS);
    expect(parking.runnerMaxDurationMs + SCOUT_LEASE_SLACK_MS).toBeLessThanOrEqual(55 * 60_000);
  });

  it('an explicit runner bound still wins with a surface probe, but never past the token-bounded cap', async () => {
    expect((await parkedWithCapture(1, { runnerMaxDurationMs: 15 * 60_000 })).runnerMaxDurationMs).toBe(15 * 60_000);
    expect((await parkedWithCapture(1, { runnerMaxDurationMs: 60 * 60_000 })).runnerMaxDurationMs).toBe(MAX_SCOUT_CAPTURE_RUNNER_DURATION_MS);
  });

  it('a command-only run keeps the 20-minute default', async () => {
    expect((await parkedWithCapture(0)).runnerMaxDurationMs).toBe(20 * 60_000);
  });

  it('scoutRunnerDuration: no capture probe is exactly clampRunnerDuration', () => {
    expect(scoutRunnerDuration(undefined, 0)).toBe(20 * 60_000);
    expect(scoutRunnerDuration(5 * 3_600_000, 0)).toBe(60 * 60_000);
    expect(scoutRunnerDuration(undefined, 2)).toBe(MAX_SCOUT_CAPTURE_RUNNER_DURATION_MS);
  });

  it('is live: a re-trigger on the same SHA is a duplicate', async () => {
    const { w } = await parked();
    const again = await runQualityScout(request({ trigger: 'periodic' }), deps(w, { ports: serverPorts(), runnerHost: runnerOffers('command') }));
    expect(again).toMatchObject({ status: 'skipped', reason: 'duplicate' });
  });

  it('is not finalized before its deadline', async () => {
    const { w, saved } = await parked();
    const at = new Date(T0.getTime() + THIRTY_MIN - 1);
    expect(await finalizeExpiredScoutRun(saved, w.probes.get(saved.id)!, deps(w, { now: () => at }))).toBeNull();
  });

  it('past its deadline with no runner: runner probes end unsupported no_runner_claimed — never pass, never dropped', async () => {
    const { w, saved } = await parked();
    const records = w.probes.get(saved.id)!;
    const runnerIds = records.filter((p) => p.host === 'runner').map((p) => p.candidateId);
    const at = new Date(T0.getTime() + THIRTY_MIN);
    const out = await finalizeExpiredScoutRun(saved, records, deps(w, { now: () => at }));
    if (out?.status !== 'completed') throw new Error(String(out?.status));
    const final = w.probes.get(saved.id)!;
    for (const id of runnerIds) {
      const p = final.find((r) => r.candidateId === id)!;
      expect(p.result?.verdict).toBe('unsupported');
      expect(p.result?.reason).toBe('no_runner_claimed');
    }
    expect(final.length).toBe(records.length);
    expect(out.metrics.verdicts.pass).toBe(final.filter((p) => p.host === 'server' && p.result?.verdict === 'pass').length);
    expect(out.metrics.hosts).toEqual({ runnerProbes: runnerIds.length, runnerExpired: runnerIds.length, expiryReason: 'no_runner_claimed', awaitingHostMs: THIRTY_MIN });
    expect(w.runs.get(saved.id)!.run.status).toBe('completed');
    expect(w.findings.size).toBe(0);
    expect(w.tasks.size).toBe(0);
  });

  it('a lease that lapsed twice finalizes as runner_host_lost, even before the deadline', async () => {
    const { w, saved } = await parked();
    const lapsed: ScoutRun = { ...saved, parking: { ...saved.parking!, leaseLapses: 1, lease: { holder: 'runner-1', expiresAt: new Date(T0.getTime() + 60_000).toISOString() } } };
    const at = new Date(T0.getTime() + 2 * 60_000);
    const out = await finalizeExpiredScoutRun(lapsed, w.probes.get(saved.id)!, deps(w, { now: () => at }));
    if (out?.status !== 'completed') throw new Error(String(out?.status));
    expect(w.probes.get(saved.id)!.filter((p) => p.host === 'runner').every((p) => p.result?.reason === 'runner_host_lost')).toBe(true);
    expect(out.metrics.hosts?.expiryReason).toBe('runner_host_lost');
  });

  it('a runner result already recorded survives expiry; only the missing ones are expired', async () => {
    const { w, saved } = await parked();
    const records = w.probes.get(saved.id)!;
    const first = records.find((p) => p.host === 'runner')!;
    const ex = await executeScoutProbes(saved, [first], saved.parking!.profile, { command: commandPort({ exitCode: 0, stdoutTail: 'Usage: tool' }).port }, {
      now: () => T0, startedAt: T0, maxDurationMs: 60_000, host: 'runner',
    });
    const withOne = records.map((p) => (p.candidateId === first.candidateId ? ex.records[0] : p));
    const out = await finalizeExpiredScoutRun(saved, withOne, deps(w, { now: () => new Date(T0.getTime() + THIRTY_MIN) }));
    if (out?.status !== 'completed') throw new Error(String(out?.status));
    const kept = w.probes.get(saved.id)!.find((p) => p.candidateId === first.candidateId)!;
    expect(kept.result?.verdict).toBe(ex.records[0].result?.verdict);
    expect(kept.result?.reason).not.toBe('no_runner_claimed');
    expect(out.metrics.hosts?.runnerExpired).toBe(out.metrics.hosts!.runnerProbes - 1);
  });

  it('a runner-hosted fail is recorded but, on first sight, files nothing in propose mode', async () => {
    const { w, saved } = await parked();
    const records = w.probes.get(saved.id)!;
    const runnerOnes = records.filter((p) => p.host === 'runner');
    const ex = await executeScoutProbes(saved, runnerOnes, saved.parking!.profile, { command: commandPort({ exitCode: 3 }).port }, {
      now: () => T0, startedAt: T0, maxDurationMs: 60_000, host: 'runner',
    });
    expect(ex.records.some((p) => p.result?.verdict === 'fail' && (p.result.confidence ?? 0) >= 0.7)).toBe(true);
    const byId = new Map(ex.records.map((p) => [p.candidateId, p]));
    const merged = records.map((p) => byId.get(p.candidateId) ?? p);
    const out = await finalizeScoutRun({ run: saved, records: merged, summary: structuredClone(saved.parking!.plan), mode: 'propose' }, deps(w, { now: () => T0 }));
    if (out?.status !== 'completed') throw new Error(String(out?.status));
    expect(w.findings.size).toBeGreaterThan(0);
    expect(w.tasks.size).toBe(0);
    expect([...w.findings.values()].every((f) => f.actionState === 'aggregated' || f.actionState === 'retained')).toBe(true);
  });

  it('a completed or never-parked run is not touched by the expiry finalizer', async () => {
    const w = memoryWorld();
    const out = await runQualityScout(request(), deps(w));
    if (out.status !== 'completed') throw new Error(out.status);
    const done = w.runs.get(out.runId)!.run;
    expect(await finalizeExpiredScoutRun(done, w.probes.get(out.runId)!, deps(w, { now: () => new Date(T0.getTime() + 10 * THIRTY_MIN) }))).toBeNull();
  });
});
