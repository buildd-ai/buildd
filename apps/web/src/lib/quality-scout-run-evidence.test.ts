/**
 * A runner cites its uploaded command log in a probe result as
 * `evidence:<id>`. The server keeps only refs to objects THIS run uploaded:
 * one naming another run's object, a malformed one, or any when the store
 * cannot check ownership, is dropped before the result is written.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { claimScoutRunForRunner, reportScoutProbeResults, SCOUT_EVIDENCE_REF_RE } from '@/lib/quality-scout-runner-host';
import { memoryHostStore, parkedRun, probeRecord, REPO, runnerResult } from '@/lib/quality-scout-runner-host.fixtures';

const WS = crypto.randomUUID();
const caller = { accountId: 'acct-1', teamId: 'team-a', accessibleWorkspaceIds: new Set([WS]), hostRunner: false };
let world = memoryHostStore();

async function claimed() {
  const run = world.add(parkedRun(WS, {}, new Date()), { teamId: 'team-a', probes: [probeRecord('c1'), probeRecord('c2')] });
  const out = await claimScoutRunForRunner({
    caller, repos: [REPO], ports: { command: true, capture: false, browser: false },
    now: new Date(), disabled: false, newLeaseId: () => crypto.randomUUID(),
  }, world.store);
  if (!out.run) throw new Error('not claimed');
  return { run, leaseId: out.lease.leaseId };
}

const storedRefs = (runId: string, candidateId: string) =>
  world.store.loadForTeam(runId, 'team-a').then((l) => l!.probes.find((p) => p.candidateId === candidateId)!.result!.evidenceRefs);

describe('evidence:<id> refs on a runner result', () => {
  beforeEach(() => { world = memoryHostStore(); });

  it("keeps a ref to this run's object, drops another run's and a malformed one, keeps other kinds", async () => {
    const { run, leaseId } = await claimed();
    const mine = crypto.randomUUID();
    const theirs = crypto.randomUUID();
    const asked: string[][] = [];
    world.store.ownedEvidenceIds = async (runId, ids) => {
      asked.push([...ids]);
      return runId === run.id ? new Set([mine]) : new Set();
    };
    const result = await runnerResult(run, probeRecord('c1'));
    const refs = [
      { kind: 'command_output', ref: `evidence:${mine}` },
      { kind: 'command_output', ref: `evidence:${theirs}` },
      { kind: 'command_output', ref: 'evidence:not-a-uuid' },
      { kind: 'command_output', ref: 'file:/tmp/scout/log.txt' },
      { kind: 'excerpt', ref: 'stdout' },
    ];
    const out = await reportScoutProbeResults({
      caller, runId: run.id, leaseId, now: new Date(),
      results: [{ candidateId: 'c1', result: { ...result, evidenceRefs: refs } }],
    }, world.store);
    expect(out.status).toBe(200);
    expect(asked).toEqual([[mine, theirs]]);
    expect(await storedRefs(run.id, 'c1')).toEqual([
      { kind: 'command_output', ref: `evidence:${mine}` },
      { kind: 'excerpt', ref: 'stdout' },
    ]);
  });

  it('a store that cannot check ownership keeps no evidence: ref (fail closed)', async () => {
    const { run, leaseId } = await claimed();
    delete (world.store as { ownedEvidenceIds?: unknown }).ownedEvidenceIds;
    const result = await runnerResult(run, probeRecord('c1'));
    await reportScoutProbeResults({
      caller, runId: run.id, leaseId, now: new Date(),
      results: [{ candidateId: 'c1', result: { ...result, evidenceRefs: [{ kind: 'command_output', ref: `evidence:${crypto.randomUUID()}` }] } }],
    }, world.store);
    expect(await storedRefs(run.id, 'c1')).toEqual([]);
  });

  it('the ref shape is evidence:<full uuid>', () => {
    expect(SCOUT_EVIDENCE_REF_RE.test(`evidence:${crypto.randomUUID()}`)).toBe(true);
    expect(SCOUT_EVIDENCE_REF_RE.test(`evidence:${crypto.randomUUID()}/x`)).toBe(false);
    expect(SCOUT_EVIDENCE_REF_RE.test('evidence:abc')).toBe(false);
  });
});
