import { describe, expect, it } from 'bun:test';
import {
  canServeScoutProbes,
  claimScoutRunForRunner,
  expectedScoutCheckIds,
  normalizeRunnerResult,
  parseScoutHostPorts,
  releaseScoutRunForRunner,
  reportScoutProbeResults,
  scoutAdvertNeeds,
  scoutLeaseHolder,
  type ScoutHostCaller,
} from './quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, profile, REPO, runnerResult, SHA, T0 } from './quality-scout-runner-host.fixtures';

const TEAM = 'team-a';
const WS = crypto.randomUUID();
const PORTS = { command: true, capture: false, browser: false };
const caller = (over: Partial<ScoutHostCaller> = {}): ScoutHostCaller => ({ accountId: 'acct-1', teamId: TEAM, accessibleWorkspaceIds: new Set([WS]), ...over });
let leaseN = 0;
const newLeaseId = () => `00000000-0000-4000-8000-${String(++leaseN).padStart(12, '0')}`;

function claimInput(over: Partial<Parameters<typeof claimScoutRunForRunner>[0]> = {}) {
  return { caller: caller(), repos: [REPO], ports: PORTS, now: T0, disabled: false, newLeaseId, ...over };
}

describe('parseScoutHostPorts / scoutAdvertNeeds', () => {
  it('needs booleans and maps ports to runner needs only', () => {
    expect(parseScoutHostPorts(null)).toBeNull();
    expect(parseScoutHostPorts({ command: 'yes' })).toBeNull();
    const ports = parseScoutHostPorts({ command: true, browser: true })!;
    expect(ports).toEqual({ command: true, capture: false, browser: true, appBoot: false });
    expect([...scoutAdvertNeeds(ports)]).toEqual(['command']);
    expect([...scoutAdvertNeeds({ command: false, capture: true, browser: false, appBoot: true })].sort()).toEqual(['app-boot', 'capture']);
  });

  it('serves a run only when every runner probe has a need the ports cover', () => {
    const cmd = probeRecord('c1');
    const surface = probeRecord('s1', { executor: 'ui-surface' });
    expect(canServeScoutProbes([cmd], profile, new Set(['command']))).toBe(true);
    expect(canServeScoutProbes([cmd, surface], profile, new Set(['command']))).toBe(false);
    expect(canServeScoutProbes([], profile, new Set(['command']))).toBe(false);
  });
});

describe('claimScoutRunForRunner', () => {
  it('leases a parked run of its team for a repo it holds, bounded by the runner duration and the deadline', async () => {
    const m = memoryHostStore();
    const run = m.add(parkedRun(WS), { teamId: TEAM, probes: [probeRecord('c1'), probeRecord('srv', { host: 'server' })] });
    const out = await claimScoutRunForRunner(claimInput(), m.store);
    if (!out.run) throw new Error('nothing claimed');
    expect(out.run.id).toBe(run.id);
    expect(out.run.candidate).toEqual({ ref: 'main', sha: SHA });
    expect(out.probes.map((p) => p.candidateId)).toEqual(['c1']);
    expect(out.profile).toEqual(profile as never);
    expect(out.lease.expiresAt).toBe(new Date(T0.getTime() + 25 * 60_000).toISOString());
    expect(m.run(run.id)!.parking!.lease!.holder).toBe(scoutLeaseHolder('acct-1', out.lease.leaseId));
    // The lease id is a bearer for this run only alongside the key: never the bare account id.
    expect(out.lease.leaseId).not.toBe('acct-1');
    expect(m.swept).toEqual([[WS]]);
  });

  it('never claims another team\'s run, even in a workspace id the key can reach', async () => {
    const m = memoryHostStore();
    m.add(parkedRun(WS), { teamId: 'team-b', probes: [probeRecord('c1')] });
    expect(await claimScoutRunForRunner(claimInput(), m.store)).toEqual({ run: null, reason: 'none' });
  });

  it('skips repos the runner has no clone of and probes its ports cannot serve', async () => {
    const m = memoryHostStore();
    m.add(parkedRun(WS), { teamId: TEAM, repo: 'acme/other', probes: [probeRecord('c1')] });
    m.add(parkedRun(WS), { teamId: TEAM, probes: [probeRecord('s1', { executor: 'ui-surface' })] });
    expect((await claimScoutRunForRunner(claimInput(), m.store)).run).toBeNull();
    expect((await claimScoutRunForRunner(claimInput({ ports: { command: false, capture: false, browser: true } }), m.store)).run).toBeNull();
  });

  it('a second claim of the same run loses while the first lease is live', async () => {
    const m = memoryHostStore();
    m.add(parkedRun(WS), { teamId: TEAM, probes: [probeRecord('c1')] });
    expect((await claimScoutRunForRunner(claimInput(), m.store)).run).not.toBeNull();
    expect((await claimScoutRunForRunner(claimInput({ caller: caller({ accountId: 'acct-2' }) }), m.store)).run).toBeNull();
  });

  it('the kill switch stops claims but the sweep still runs', async () => {
    const m = memoryHostStore();
    m.setSweepResult(['old-run']);
    m.add(parkedRun(WS), { teamId: TEAM, probes: [probeRecord('c1')] });
    expect(await claimScoutRunForRunner(claimInput({ disabled: true }), m.store)).toEqual({ run: null, reason: 'disabled', expired: ['old-run'] });
    expect(m.swept).toHaveLength(1);
  });

  it('a key that reaches no workspace claims nothing and sweeps nothing', async () => {
    const m = memoryHostStore();
    m.add(parkedRun(WS), { teamId: TEAM, probes: [probeRecord('c1')] });
    expect(await claimScoutRunForRunner(claimInput({ caller: caller({ accessibleWorkspaceIds: new Set() }) }), m.store)).toEqual({ run: null, reason: 'none' });
    expect(m.swept).toHaveLength(0);
  });
});

describe('normalizeRunnerResult', () => {
  it('keeps the runner\'s verdict and bounded fields; check, subject and provenance are the server\'s', async () => {
    const run = parkedRun(WS);
    const probe = probeRecord('c1');
    const real = await runnerResult(run, probe);
    expect(expectedScoutCheckIds(probe, profile).has(real.checkId)).toBe(true);
    const out = normalizeRunnerResult(run, probe, profile, {
      ...real,
      checkVersion: 99,
      provenance: { flavor: 'forged', origin: 'run:other', executor: 'scout-command', ranAt: '2999-01-01T00:00:00Z' },
      observed: 'x'.repeat(5_000),
      evidenceRefs: [{ kind: 'log', ref: 'file:/home/runner/log.txt' }, { kind: 'log', ref: 'scout-probe-row:c1' }],
    }, T0);
    if (!out.ok) throw new Error(out.code);
    expect(out.result.verdict).toBe(real.verdict);
    expect(out.result.checkVersion).toBe(1);
    expect(out.result.subject).toEqual({ kind: 'candidate-sha', ref: SHA });
    expect(out.result.provenance).toEqual({ flavor: 'quality-scout', origin: `run:${run.id}`, executor: 'scout-command', ranAt: T0.toISOString() });
    expect(out.result.observed!.length).toBe(500);
    expect(out.result.evidenceRefs).toEqual([{ kind: 'log', ref: 'scout-probe-row:c1' }]);
  });

  it('refuses a result for another check, another SHA, or with a bad verdict or signature', async () => {
    const run = parkedRun(WS);
    const probe = probeRecord('c1');
    const real = await runnerResult(run, probe);
    const code = (raw: unknown) => { const r = normalizeRunnerResult(run, probe, profile, raw, T0); return r.ok ? 'ok' : r.code; };
    expect(code({ ...real, checkId: 'quality-scout:other' })).toBe('wrong_check');
    expect(code({ ...real, subject: { kind: 'candidate-sha', ref: 'f'.repeat(40) } })).toBe('wrong_sha');
    expect(code({ ...real, verdict: 'passish' })).toBe('bad_verdict');
    expect(code({ ...real, signature: 'nope' })).toBe('bad_signature');
    expect(code('x')).toBe('malformed_result');
  });

  it('a fail with no valid severity takes the probe\'s risk', async () => {
    const run = parkedRun(WS);
    const probe = probeRecord('c1', { risk: 'high' });
    const real = await runnerResult(run, probe, { exitCode: 3 });
    expect(real.verdict).toBe('fail');
    const out = normalizeRunnerResult(run, probe, profile, { ...real, severity: 'apocalyptic' }, T0);
    expect(out.ok && out.result.severity).toBe('high');
  });
});

async function claimed(m: ReturnType<typeof memoryHostStore>, probes = [probeRecord('c1')]) {
  const run = m.add(parkedRun(WS), { teamId: TEAM, probes });
  const out = await claimScoutRunForRunner(claimInput(), m.store);
  if (!out.run) throw new Error('nothing claimed');
  return { run, leaseId: out.lease.leaseId };
}

describe('reportScoutProbeResults', () => {
  it('the last result finalizes the run on the server', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m);
    const result = await runnerResult(run, probeRecord('c1'));
    const out = await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [{ candidateId: 'c1', result, reproducibility: 'deterministic' }] }, m.store);
    expect(out).toEqual({ status: 200, body: { accepted: ['c1'], remaining: 0, finalized: true, runStatus: 'completed' } });
    expect(m.finalized).toHaveLength(1);
    expect(m.finalized[0].probes.find((p) => p.candidateId === 'c1')!.result!.verdict).toBe('pass');
    expect(m.finalized[0].run.parking!.plan.reproducibility).toEqual({ c1: 'deterministic' });
    expect(m.run(run.id)!.status).toBe('completed');
  });

  it('a partial report does not finalize', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m, [probeRecord('c1'), probeRecord('c2')]);
    const result = await runnerResult(run, probeRecord('c1'));
    const out = await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [{ candidateId: 'c1', result }] }, m.store);
    expect(out.body).toEqual({ accepted: ['c1'], remaining: 1, finalized: false });
    expect(m.finalized).toHaveLength(0);
  });

  it('refuses a probe the run did not assign to a runner, writing nothing', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m, [probeRecord('c1'), probeRecord('srv', { host: 'server' })]);
    const good = await runnerResult(run, probeRecord('c1'));
    for (const candidateId of ['srv', 'never-planned']) {
      const out = await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [{ candidateId: 'c1', result: good }, { candidateId, result: good }] }, m.store);
      expect(out.status).toBe(422);
      expect((out.body as { code: string }).code).toBe('probe_not_assigned');
    }
    expect(m.probes(run.id).find((p) => p.candidateId === 'c1')!.result).toBeNull();
  });

  it('refuses an already-reported probe', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m, [probeRecord('c1'), probeRecord('c2')]);
    const result = await runnerResult(run, probeRecord('c1'));
    await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [{ candidateId: 'c1', result }] }, m.store);
    const again = await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [{ candidateId: 'c1', result }] }, m.store);
    expect(again.status).toBe(409);
    expect((again.body as { code: string }).code).toBe('probe_already_reported');
  });

  it('accepts results only from the key and lease that hold the run', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m);
    const result = await runnerResult(run, probeRecord('c1'));
    const results = [{ candidateId: 'c1', result }];
    const code = async (c: ScoutHostCaller, l: unknown, now = T0) => {
      const out = await reportScoutProbeResults({ caller: c, runId: run.id, leaseId: l, now, results }, m.store);
      return (out.body as { code?: string }).code ?? out.status;
    };
    expect(await code(caller({ accountId: 'acct-2' }), leaseId)).toBe('lease_not_held');
    expect(await code(caller(), newLeaseId())).toBe('lease_not_held');
    expect(await code(caller(), undefined)).toBe('lease_required');
    expect(await code(caller({ teamId: 'team-b' }), leaseId)).toBe('run_not_found');
    expect(await code(caller({ accessibleWorkspaceIds: new Set() }), leaseId)).toBe('run_not_found');
    expect(await code(caller(), leaseId, new Date(T0.getTime() + 26 * 60_000))).toBe('lease_expired');
    expect(m.finalized).toHaveLength(0);
  });

  it('bounds the batch', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m);
    const many = Array.from({ length: 11 }, (_, i) => ({ candidateId: `c${i}`, result: {} }));
    expect((await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: many }, m.store)).status).toBe(413);
    expect((await reportScoutProbeResults({ caller: caller(), runId: run.id, leaseId, now: T0, results: [] }, m.store)).status).toBe(400);
  });
});

describe('releaseScoutRunForRunner', () => {
  it('hands the run back, unclaimed, and another runner can then claim it', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m);
    const out = await releaseScoutRunForRunner({ caller: caller(), runId: run.id, leaseId, reason: 'cannot fetch sha', now: T0 }, m.store);
    expect(out).toEqual({ status: 200, body: { released: true } });
    expect(m.released).toEqual(['cannot fetch sha']);
    expect(m.run(run.id)!.parking!.lease).toBeNull();
    // A release is not a lapse.
    expect(m.run(run.id)!.parking!.leaseLapses).toBe(0);
    expect((await claimScoutRunForRunner(claimInput({ caller: caller({ accountId: 'acct-2' }) }), m.store)).run?.id).toBe(run.id);
  });

  it('needs a reason and the held lease', async () => {
    const m = memoryHostStore();
    const { run, leaseId } = await claimed(m);
    expect((await releaseScoutRunForRunner({ caller: caller(), runId: run.id, leaseId, reason: ' ', now: T0 }, m.store)).status).toBe(400);
    const other = await releaseScoutRunForRunner({ caller: caller({ accountId: 'acct-2' }), runId: run.id, leaseId, reason: 'x', now: T0 }, m.store);
    expect((other.body as { code: string }).code).toBe('lease_not_held');
  });
});
