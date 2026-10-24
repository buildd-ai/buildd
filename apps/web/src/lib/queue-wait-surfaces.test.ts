/**
 * One waiting reason on every surface (spec: Overlap scheduling, AC-10;
 * Health › Queue, AC-9). A table per reason: the one queue wait the claim
 * route's own query and gates give (lib/queue-wait-load.ts) goes into the
 * state view the way explain and the mission rows load it, and comes out the
 * same on the header chip, `waitingOn`, the presentation, explain's because[]
 * chain and the mission card's row hold. Only a slot wait is "next in line".
 */
import { describe, expect, it } from 'bun:test';
import { isNextInLine, type QueueWait } from '@buildd/shared';
import { deriveMissionStateView, type MissionStateInput } from './mission-state-view';
import { presentMissionState } from './mission-state-presentation';
import { buildStateBecause } from './explain-because';
import { derivePendingTaskHold } from './mission-task-hold';
import { cardTaskHolds } from './mission-card-view';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const at = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;

interface Row { name: string; wait: QueueWait; cause: string }

/** The cause each wait reads as, on every surface. */
const TABLE: Row[] = [
  { name: 'declared dependency', wait: { kind: 'declared', blockerId: 'dep-1', blockerTitle: '“Rework claim order”', blockerStatus: 'in_progress', count: 1 }, cause: 'Waiting on “Rework claim order”' },
  { name: 'lane position', wait: { kind: 'lane', lane: 'migration', position: 2, holderTaskId: 'h' }, cause: 'in the schema lane, 2nd in line' },
  { name: 'limit: pacing', wait: { kind: 'limit', limit: 'mission_pacing', liftsAt: at(4 * MIN), forceable: true }, cause: 'mission pacing, lifts in 4m' },
  { name: 'limit: cap', wait: { kind: 'limit', limit: 'workspace_cap', forceable: false }, cause: 'workspace limit' },
  { name: 'limit: plan', wait: { kind: 'limit', limit: 'plan', forceable: false }, cause: 'plan limit' },
  { name: 'limit: budget', wait: { kind: 'limit', limit: 'budget', liftsAt: at(90 * MIN), forceable: false }, cause: 'daily budget, lifts in 1h 30m' },
  { name: 'limit: seats', wait: { kind: 'limit', limit: 'seats', forceable: false }, cause: 'seats in use' },
  { name: 'start time', wait: { kind: 'start_time', startAt: at(3 * 60 * MIN) }, cause: 'starts in 3h 00m' },
  { name: 'free slot', wait: { kind: 'slot', noRunnerReason: null }, cause: 'next in line for a runner' },
];

const input = (wait: QueueWait): MissionStateInput => ({
  status: 'active', isHeld: false, activeAgents: 0, health: 'STALLED', now: NOW,
  openTasks: [{ id: 't1', status: 'pending', title: 'Add the run table', queueWait: wait }],
});

describe('one queue wait, the same reason on every surface', () => {
  for (const row of TABLE) {
    it(row.name, () => {
      const view = deriveMissionStateView(input(row.wait));
      const hold = derivePendingTaskHold({ now: NOW, wait: row.wait });
      const text = row.wait.kind === 'declared' ? hold.word : hold.cause;
      expect(text).toBe(row.cause);

      // Header chip: NEXT IN LINE only for a slot wait.
      if (isNextInLine(row.wait)) expect(view.chip.label).toBe('NEXT IN LINE');
      else expect(view.chip.label).not.toBe('NEXT IN LINE');

      // waitingOn + presentation say the same reason (the declared wait as the dependency it is).
      const label = JSON.stringify(view.waitingOn);
      const presentation = presentMissionState(view);
      if (row.wait.kind === 'declared') {
        expect(label).toContain('Rework claim order');
        expect(presentation.cause).toBe('dependency');
      } else if (row.wait.kind === 'slot') {
        expect(presentation.causeText).toBe('next in line for a runner');
      } else {
        expect(label).toContain(row.cause);
        expect(presentation.causeText).toBe(row.cause);
        expect(presentation.causeText).not.toContain('next in line');
      }

      // explain's because[] chain names it, from the claim gates.
      const chain = buildStateBecause(view, { missionId: 'm', workspaceId: 'ws' }, {
        openTasks: [{ id: 't1', title: 'Add the run table', status: 'pending', pendingHold: { row: hold.row, kind: hold.kind, holder: hold.holder, fromClaimGates: true } }],
      });
      const claims = chain.map(l => l.claim).join('\n');
      expect(claims).toContain(row.wait.kind === 'declared' ? '“Rework claim order”' : row.wait.kind === 'slot' ? 'next in line for a runner' : hold.row);
      if (!isNextInLine(row.wait)) expect(claims).not.toContain('next in line');

      // The mission card's row hold: the same hold.
      const card = cardTaskHolds(
        { executor: 'runner', tasks: [{ id: 't1', title: 'Add the run table', status: 'pending', taskClass: 'work', workers: [] }] } as never,
        { now: NOW, facts: { queueWaits: new Map([['t1', row.wait]]) } },
      ).get('t1')!;
      expect(card.row).toBe(hold.row);
    });
  }

  it('2026-10-22: no fresh refusal recorded, a slot read from ledger silence, but the claim gates say lane: the view never says next in line', () => {
    const view = deriveMissionStateView({
      ...input({ kind: 'lane', lane: 'migration', position: 5, holderTaskId: 'h' }),
      openTasks: [{ id: 't1', status: 'pending', title: 'Schema', deferral: null, holdReason: null, queueWait: { kind: 'lane', lane: 'migration', position: 5, holderTaskId: 'h' } }],
    });
    expect(view.chip.label).not.toBe('NEXT IN LINE');
    expect(JSON.stringify(view.waitingOn)).toContain('in the schema lane, 5th in line');
  });

  it('2026-10-22: a declared dependency the status read missed still reads as the dependency', () => {
    const view = deriveMissionStateView({
      ...input({ kind: 'declared', blockerId: 'run-1', blockerTitle: '“Rework claim order”', blockerStatus: 'in_progress', count: 1 }),
      openTasks: [{ id: 't1', status: 'pending', title: 'Explain', waitingOnTaskIds: [], queueWait: { kind: 'declared', blockerId: 'run-1', blockerTitle: '“Rework claim order”', blockerStatus: 'in_progress', count: 1 } }],
    });
    expect(view.chip.label).not.toBe('NEXT IN LINE');
    expect(JSON.stringify(view.waitingOn)).toContain('Rework claim order');
  });

  it('a slot wait releases a row the status read thinks is dependency-held: the claim query returns it', () => {
    const view = deriveMissionStateView({
      ...input({ kind: 'slot', noRunnerReason: null }),
      openTasks: [{ id: 't1', status: 'pending', title: 'Released early', waitingOnTaskIds: ['dep-1'], queueWait: { kind: 'slot', noRunnerReason: null } }],
    });
    expect(view.chip.label).toBe('NEXT IN LINE');
  });
});
