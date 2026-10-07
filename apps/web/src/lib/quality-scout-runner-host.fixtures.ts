/**
 * Test fixtures for the Scout runner-host API: an in-memory
 * `ScoutRunnerHostStore` that applies the same predicates the SQL store does
 * (team, workspace, deadline, lease free / held), and a parked run with one
 * runner-assigned command probe. The SQL itself is pinned against real
 * Postgres in apps/web/tests/db/quality-scout-runner-host.test.ts.
 */
import { computeReadiness } from '@buildd/core/workspace-readiness';
import { discoverScoutCapabilities, type ScoutCapabilityProfile } from '@buildd/core/scout-capabilities';
import { runScoutProbe, type ScoutCommandOutput } from '@buildd/core/quality-scout/executors';
import type { ScoutProbeRecord, ScoutRun } from '@buildd/core/quality-scout/types';
import type { VerificationResult } from '@buildd/core/verification-check';
import type { ScoutRunOutcome } from '@/lib/quality-scout-run';
import type { ScoutRunnerHostStore } from '@/lib/quality-scout-runner-host';

export const SHA = 'e'.repeat(40);
export const T0 = new Date('2026-10-06T12:00:00Z');
export const REPO = 'acme/tool';

/** A Python CLI with one declared journey: a command probe only a runner can host. */
export const profile: ScoutCapabilityProfile = discoverScoutCapabilities({
  readiness: computeReadiness({
    files: ['pyproject.toml', 'uv.lock', 'src/tool/cli.py'],
    manifests: { 'pyproject.toml': '[project]\nname = "tool"\n' },
  }),
  extension: { journeys: [{ name: 'help', kind: 'cli', command: 'uv run tool --help', mutates: false, expect: 'exit 0' }] },
});

export function probeRecord(candidateId: string, over: Partial<ScoutProbeRecord> = {}): ScoutProbeRecord {
  return {
    candidateId,
    family: 'contract',
    probeKind: 'cli-journey',
    title: `probe ${candidateId}`,
    invariant: 'the CLI prints usage and exits 0',
    sourceSignals: [],
    preconditions: [],
    executor: 'cli-journey:help',
    estimatedCost: 'low',
    risk: 'medium',
    mutates: false,
    evidenceRequirements: [],
    unsupportedReason: null,
    selection: { status: 'selected', via: 'decision', reasonCode: 'test', decisionSource: null },
    host: 'runner',
    result: null,
    ...over,
  };
}

/** Parked at `at` (default T0): deadline 30 min later, runner bound 20 min. */
export function parkedRun(workspaceId: string, over: Partial<ScoutRun> = {}, at: Date = T0): ScoutRun {
  return {
    id: crypto.randomUUID(),
    workspaceId,
    missionId: null,
    trigger: 'manual',
    mode: 'shadow',
    status: 'awaiting_host',
    candidate: { ref: 'main', sha: SHA },
    prior: null,
    budget: { maxProbes: 4, maxCostUsd: null },
    policyVersion: 'scout-v1',
    startedAt: at.toISOString(),
    completedAt: null,
    error: null,
    parking: {
      parkedAt: at.toISOString(),
      hostDeadline: new Date(at.getTime() + 30 * 60_000).toISOString(),
      runnerMaxDurationMs: 20 * 60_000,
      profile,
      plan: {
        candidatesGenerated: 1,
        candidatesTruncated: 0,
        decisionsAsked: 0,
        decisionFailures: 0,
        costCapHit: false,
        stages: {
          profile: { ms: 0, costUsd: null },
          signals: { ms: 0, costUsd: null },
          generate: { ms: 0, costUsd: null },
          select: { ms: 0, costUsd: null },
          execute: { ms: 0, costUsd: null },
          act: { ms: 0, costUsd: null },
        },
        warnings: [],
        deadlineHit: false,
        reproducibility: {},
      },
      lease: null,
      leaseLapses: 0,
    },
    ...over,
  };
}

/** What a runner would post for `probe`: the real executor, over a fake command port. */
export async function runnerResult(run: ScoutRun, probe: ScoutProbeRecord, out: Partial<ScoutCommandOutput> = {}): Promise<VerificationResult> {
  const exec = await runScoutProbe(run, probe, profile, {
    command: { run: async () => ({ exitCode: 0, timedOut: false, stdoutTail: 'Usage: tool', ...out }) },
  }, { now: () => T0 });
  return exec.probe.result!;
}

interface Row { run: ScoutRun; teamId: string; repo: string | null }

export function memoryHostStore() {
  const rows = new Map<string, Row>();
  const probes = new Map<string, ScoutProbeRecord[]>();
  const finalized: Array<{ run: ScoutRun; probes: ScoutProbeRecord[] }> = [];
  const swept: string[][] = [];
  const released: string[] = [];
  let sweepResult: string[] = [];

  const leaseFree = (r: ScoutRun, now: Date) => {
    const l = r.parking?.lease;
    return !l || (Date.parse(l.expiresAt) <= now.getTime() && r.parking!.leaseLapses === 0);
  };
  const pending = (p: ScoutProbeRecord) => p.selection.status === 'selected' && p.host === 'runner' && !p.result;
  const held = (r: ScoutRun, holder: string, now: Date) =>
    r.status === 'awaiting_host' && r.parking?.lease?.holder === holder && Date.parse(r.parking.lease.expiresAt) > now.getTime();

  const store: ScoutRunnerHostStore = {
    async sweepExpired(ids) {
      swept.push([...ids]);
      return sweepResult;
    },
    async listClaimable({ teamId, workspaceIds, now, limit }) {
      return [...rows.values()]
        .filter((r) => r.run.status === 'awaiting_host' && r.teamId === teamId && workspaceIds.includes(r.run.workspaceId)
          && Date.parse(r.run.parking!.hostDeadline) > now.getTime() && leaseFree(r.run, now))
        .sort((a, b) => Date.parse(a.run.parking!.hostDeadline) - Date.parse(b.run.parking!.hostDeadline))
        .slice(0, limit)
        .map((r) => ({ run: r.run, repo: r.repo, probes: (probes.get(r.run.id) ?? []).filter(pending) }));
    },
    async claim({ runId, teamId, holder, now, leaseExpiresAt }) {
      const r = rows.get(runId);
      if (!r || r.teamId !== teamId || r.run.status !== 'awaiting_host' || Date.parse(r.run.parking!.hostDeadline) <= now.getTime() || !leaseFree(r.run, now)) return null;
      const p = r.run.parking!;
      r.run = { ...r.run, parking: { ...p, lease: { holder, expiresAt: leaseExpiresAt.toISOString() }, leaseLapses: p.lease ? p.leaseLapses + 1 : p.leaseLapses } };
      return r.run;
    },
    async loadForTeam(runId, teamId) {
      const r = rows.get(runId);
      if (!r || r.teamId !== teamId) return null;
      return { run: r.run, probes: probes.get(runId) ?? [] };
    },
    async recordResult({ runId, holder, now, candidateId, result, reproducibility }) {
      const r = rows.get(runId);
      if (!r || !held(r.run, holder, now)) return false;
      const list = probes.get(runId) ?? [];
      const i = list.findIndex((p) => p.candidateId === candidateId && pending(p));
      if (i < 0) return false;
      list[i] = { ...list[i], result };
      const p = r.run.parking!;
      r.run = { ...r.run, parking: { ...p, plan: { ...p.plan, reproducibility: { ...p.plan.reproducibility, [candidateId]: reproducibility } } } };
      return true;
    },
    async remainingRunnerProbes(runId) {
      return (probes.get(runId) ?? []).filter(pending).length;
    },
    async take(runId, holder) {
      const r = rows.get(runId);
      if (!r || r.run.status !== 'awaiting_host' || r.run.parking?.lease?.holder !== holder) return false;
      r.run = { ...r.run, status: 'running' };
      return true;
    },
    async finalize(run, ps): Promise<ScoutRunOutcome> {
      finalized.push({ run, probes: [...ps] });
      const r = rows.get(run.id)!;
      r.run = { ...r.run, status: 'completed' };
      return { status: 'completed', runId: run.id, metrics: {} as never };
    },
    async release({ runId, holder, now, reason }) {
      const r = rows.get(runId);
      if (!r || !held(r.run, holder, now)) return false;
      r.run = { ...r.run, parking: { ...r.run.parking!, lease: null } };
      released.push(reason);
      return true;
    },
  };

  return {
    store,
    finalized,
    swept,
    released,
    setSweepResult(ids: string[]) { sweepResult = ids; },
    add(run: ScoutRun, opts: { teamId: string; repo?: string | null; probes: ScoutProbeRecord[] }) {
      rows.set(run.id, { run, teamId: opts.teamId, repo: opts.repo === undefined ? REPO : opts.repo });
      probes.set(run.id, opts.probes);
      return run;
    },
    run(id: string) { return rows.get(id)?.run; },
    probes(id: string) { return probes.get(id) ?? []; },
  };
}
