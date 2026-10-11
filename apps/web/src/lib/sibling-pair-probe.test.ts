import { describe, expect, it } from 'bun:test';
import { loadPairProbeEvidence, pairProbeEvidence, type PairProbeDeps } from './sibling-pair-probe';

const at = new Date('2026-10-08T12:00:00Z');
const ev = (detail: Record<string, unknown>) => ({ occurredAt: at, detail });
const a = { id: 'a', lastCommitSha: 'a'.repeat(40) };
const b = { id: 'b', lastCommitSha: 'b'.repeat(40) };

describe('pairProbeEvidence', () => {
  it('is current when the recorded heads are the two workers\' commits, in either order', () => {
    const swapped = ev({ probeOutcome: 'conflict', conflictFiles: ['x.ts'], headSha: b.lastCommitSha, otherSha: a.lastCommitSha });
    expect(pairProbeEvidence(swapped, a, b)).toEqual({ outcome: 'conflict', conflictFiles: ['x.ts'], probedAt: at.toISOString(), headsCurrent: true });
  });

  it('is stale once either branch moved', () => {
    const e = ev({ probeOutcome: 'clean', headSha: a.lastCommitSha, otherSha: b.lastCommitSha });
    expect(pairProbeEvidence(e, { ...a, lastCommitSha: 'c'.repeat(40) }, b)?.headsCurrent).toBe(false);
  });

  it('is stale when a head is unknown', () => {
    const e = ev({ probeOutcome: 'clean', headSha: a.lastCommitSha, otherSha: b.lastCommitSha });
    expect(pairProbeEvidence(e, { ...a, lastCommitSha: null }, b)?.headsCurrent).toBe(false);
  });

  it('is null without a recognisable outcome', () => {
    expect(pairProbeEvidence(null, a, b)).toBeNull();
    expect(pairProbeEvidence(ev({ probeOutcome: 'weird' }), a, b)).toBeNull();
  });
});

describe('loadPairProbeEvidence', () => {
  const deps = (over: Partial<PairProbeDeps> = {}): PairProbeDeps => ({
    findWorker: async (_w, ref) => (ref.branch === 'cand' ? a : b),
    latestProbeEvent: async () => ev({ probeOutcome: 'mergiraf_resolved', headSha: a.lastCommitSha, otherSha: b.lastCommitSha }),
    ...over,
  });

  it('needs the candidate to have a branch', async () => {
    expect(await loadPairProbeEvidence({ workspaceId: 'w', candidate: {}, holder: { taskId: 't' } }, deps())).toBeNull();
  });

  it('returns the pair\'s newest probe', async () => {
    const out = await loadPairProbeEvidence({ workspaceId: 'w', candidate: { branch: 'cand' }, holder: { branch: 'h' } }, deps());
    expect(out?.outcome).toBe('mergiraf_resolved');
    expect(out?.headsCurrent).toBe(true);
  });

  it('swallows a failed read', async () => {
    const out = await loadPairProbeEvidence({ workspaceId: 'w', candidate: { branch: 'cand' }, holder: { branch: 'h' } },
      deps({ latestProbeEvent: async () => { throw new Error('db'); } }));
    expect(out).toBeNull();
  });
});
