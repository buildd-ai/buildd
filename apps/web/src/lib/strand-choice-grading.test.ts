import { describe, expect, it } from 'bun:test';
import { gradeStrandChoiceDecisions, type StrandGradingStore, type UngradedStrandDecision } from './strand-choice-grading';
import { STRAND_GOLD_SOURCE, STRAND_GOLD_WINDOW_MS } from './strand-choice-gold';

const NOW = new Date('2026-10-05T12:00:00Z');
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);

function rec(id: string, over: Partial<UngradedStrandDecision> = {}): UngradedStrandDecision {
  return { id, teamId: 'team-a', missionId: 'mission-1', verdict: 'wait-for-local', createdAt: ago(24), ...over };
}

function fakeStore(over: Partial<StrandGradingStore> & { records?: UngradedStrandDecision[] } = {}) {
  const listCalls: Array<{ since: Date; before: Date; limit: number }> = [];
  const store: StrandGradingStore = {
    async listUngraded(o) { listCalls.push(o); return over.records ?? []; },
    async loadMissions() { return new Map(); },
    async loadTaps() { return new Map(); },
    ...over,
  };
  return { store, listCalls };
}

function labeller() {
  const labels: any[] = [];
  const label = async (l: any) => { labels.push(l); return { ok: true as const, results: [{ decisionRecordId: l.decisionRecordId, status: 'recorded' as const }] }; };
  return { labels, label };
}

describe('gradeStrandChoiceDecisions', () => {
  it('lists only decisions whose window has closed, bounded', async () => {
    const { store, listCalls } = fakeStore();
    const res = await gradeStrandChoiceDecisions({ now: NOW, limit: 50 }, { store, label: labeller().label });
    expect(res).toMatchObject({ scanned: 0, labelled: 0 });
    expect(listCalls[0].before.getTime()).toBe(NOW.getTime() - STRAND_GOLD_WINDOW_MS);
    expect(listCalls[0].limit).toBe(50);
    expect(listCalls[0].since.getTime()).toBeLessThan(listCalls[0].before.getTime());
  });

  it('labels each decision from its own mission, claims and tap, with the right answer as the label', async () => {
    const { store } = fakeStore({
      records: [
        rec('d-1'),
        rec('d-2', { missionId: 'mission-2', verdict: 'wait-for-local' }),
        rec('d-3', { missionId: 'mission-3', verdict: 'continue-on-runner' }),
      ],
      async loadMissions(ids) {
        expect(ids.sort()).toEqual(['mission-1', 'mission-2', 'mission-3']);
        return new Map([
          ['mission-1', { ended: false, claims: [{ runner: 'mcp', at: ago(22) }] }],
          ['mission-2', { ended: false, claims: [] }],
          ['mission-3', { ended: false, claims: [{ runner: 'runner-host', at: ago(23) }] }],
        ]);
      },
    });
    const { labels, label } = labeller();
    const res = await gradeStrandChoiceDecisions({ now: NOW }, { store, label });
    expect(res).toMatchObject({ scanned: 3, labelled: 3, unknown: {}, conflicts: 0, errors: 0 });
    expect(labels).toEqual([
      { teamId: 'team-a', decisionRecordId: 'd-1', source: STRAND_GOLD_SOURCE, label: 'wait-for-local', value: 120, metadata: { reason: 'local_returned' }, observedAt: ago(22) },
      { teamId: 'team-a', decisionRecordId: 'd-2', source: STRAND_GOLD_SOURCE, label: 'continue-on-runner', value: null, metadata: { reason: 'local_absent' }, observedAt: new Date(ago(24).getTime() + STRAND_GOLD_WINDOW_MS) },
      { teamId: 'team-a', decisionRecordId: 'd-3', source: STRAND_GOLD_SOURCE, label: 'continue-on-runner', value: 60, metadata: { reason: 'moved_to_runner' }, observedAt: ago(23) },
    ]);
  });

  it('uses the owner tap on that decision', async () => {
    const { store } = fakeStore({
      records: [rec('d-1', { verdict: 'continue-on-runner' })],
      async loadMissions() { return new Map([['mission-1', { ended: false, claims: [] }]]); },
      async loadTaps(ids) { expect(ids).toEqual(['d-1']); return new Map([['d-1', { button: 'continue-on-runner', at: ago(23.5) }]]); },
    });
    const { labels, label } = labeller();
    await gradeStrandChoiceDecisions({ now: NOW }, { store, label });
    expect(labels[0]).toMatchObject({ label: 'continue-on-runner', metadata: { reason: 'owner_moved_to_runner' }, value: 30 });
  });

  it('writes nothing when the evidence is missing, and counts why', async () => {
    const { store } = fakeStore({
      records: [rec('d-1'), rec('d-2', { missionId: 'gone' }), rec('d-3', { missionId: null })],
      async loadMissions() { return new Map([['mission-1', { ended: true, claims: [] }]]); },
    });
    const { labels, label } = labeller();
    const res = await gradeStrandChoiceDecisions({ now: NOW }, { store, label });
    expect(labels).toEqual([]);
    expect(res).toMatchObject({ scanned: 3, labelled: 0, unknown: { mission_ended: 1, mission_missing: 2 } });
  });

  it('a conflicting earlier label is counted, not overwritten; a store failure is contained', async () => {
    const { store } = fakeStore({
      records: [rec('d-1')],
      async loadMissions() { return new Map([['mission-1', { ended: false, claims: [{ runner: 'mcp', at: ago(23) }] }]]); },
    });
    const conflict = async (l: any) => ({ ok: true as const, results: [{ decisionRecordId: l.decisionRecordId, status: 'conflict' as const, existing: { label: 'continue-on-runner', value: null } }] });
    expect(await gradeStrandChoiceDecisions({ now: NOW }, { store, label: conflict })).toMatchObject({ labelled: 0, conflicts: 1 });

    const broken = fakeStore({ async listUngraded() { throw new Error('db down'); } });
    expect(await gradeStrandChoiceDecisions({ now: NOW }, { store: broken.store, label: labeller().label })).toMatchObject({ errors: 1, scanned: 0 });
  });
});
