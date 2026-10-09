/**
 * Mission detail's per-task delivery (`missionTaskDeliveries`): each task's
 * Build › Audit › Land and its audit/repair evidence, from the page's rows.
 * Illustrative rows only: the dev fixture's 35-task, 2-remaining mission.
 */
import { describe, expect, it } from 'bun:test';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery } from '@/lib/delivery-projection';
import { stripSlots } from '@/lib/mission-task-strip';
import {
  DELIVERY_HELD, DELIVERY_REPAIRING, deliveryFixtureRows, missionTaskStripFixture, stripFixtureId,
} from '../../../dev/fixtures/mission-task-strip-fixtures';
import { missionTaskDeliveries } from './mission-task-delivery';

const f = missionTaskStripFixture('delivery');
const d = f.deliveries!;
const of = (n: number) => d[stripFixtureId(n)];

describe('missionTaskDeliveries', () => {
  it('one detail per deliverable: attempts fold in, never get their own', () => {
    expect(Object.keys(d)).toHaveLength(35);
    for (const n of [101, 102, 103]) expect(d[stripFixtureId(n)]).toBeUndefined();
    // The strip draws the same 35 cells: no duplicate for a repair or a review run.
    expect(stripSlots(f.model)).toHaveLength(35);
  });

  it('a task on its second automatic repair: Audit with the round, Land still ahead', () => {
    const t = of(DELIVERY_REPAIRING);
    expect(t.kind).toBe('repair');
    expect(t.repairRounds).toBe(2);
    expect(t.stages).toEqual({ build: 'PR #434 opened', audit: 'Repair 2 · CI failed', land: 'After Audit' });
  });

  it('its evidence is revision-scoped, newest first, with each repair between two heads', () => {
    const ev = of(DELIVERY_REPAIRING).evidence;
    expect(ev.map(e => (e.type === 'repair' ? `repair ${e.round} ${e.status}` : `rev ${e.sha} ${e.current ? 'current' : 'older'}`))).toEqual([
      'repair 2 running', 'rev d4e5f60 current', 'repair 1 pushed', 'rev a1b2c3d older',
    ]);
    const older = ev[3];
    expect(older.type === 'revision' && older.gates.find(g => g.name === 'Code review')?.result).toBe('changes requested');
    const current = ev[1];
    expect(current.type === 'revision' && current.gates.find(g => g.name === 'CI')?.result).toBe('failed');
    expect(of(DELIVERY_REPAIRING).revisions).toBe(2);
    expect(of(DELIVERY_REPAIRING).repairs).toBe(2);
  });

  it('the held task has not started and has nothing to expand', () => {
    const t = of(DELIVERY_HELD);
    expect(t.kind).toBe('waiting');
    expect(t.stages).toEqual({ build: 'Not started', audit: 'After Build', land: 'After Audit' });
    expect(t.evidence).toEqual([]);
  });

  it('a landed task with no recorded review says so, and has no empty disclosure', () => {
    const t = of(1);
    expect(t.kind).toBe('landed');
    expect(t.stages).toEqual({ build: 'PR #401 opened', audit: 'No review recorded', land: 'Merged' });
    expect(t.evidence).toEqual([]);
  });

  it('each task reads the mission projection Home, Missions and Activity read', () => {
    const { rows } = deliveryFixtureRows();
    const mission = projectMissionDelivery({ id: 'm', title: 'm', status: 'active', href: '', tasks: rows }, missionHelpers);
    for (const t of mission.tasks) expect(d[t.id].kind).toBe(t.delivery.kind);
    expect(mission.landed).toBe(33);
    expect(mission.total).toBe(35);
  });

  it('after a repair goes green, a verdict on the new head counts and Audit names what passed', () => {
    const { rows } = deliveryFixtureRows();
    const id = stripFixtureId(DELIVERY_REPAIRING);
    const H = 'd4e5f60718293a4b';
    const approved = missionTaskDeliveries({
      mission: { id: 'm', title: 'm', status: 'active' },
      tasks: [
        ...rows.filter(r => r.id === id || r.parentTaskId === id).filter(r => r.id !== stripFixtureId(103))
          .map(r => (r.id === id ? { ...r, workers: r.workers.map(w => ({ ...w, prLifecycleStatus: 'ci_green' })) } : r)),
        { id: 'rv2', title: '[reviewer #2] feat(billing): scheduled export email', status: 'completed', taskClass: 'attempt', parentTaskId: id, createdAt: new Date(Date.UTC(2026, 0, 1, 13)) },
      ],
      digestOf: x => (x === 'rv2' ? { result: { structuredOutput: { verdict: 'approve' } }, context: { headSha: H } } : x === stripFixtureId(101) ? { result: { effectiveVerdict: 'request-changes' }, context: { headSha: 'a1b2c3d4e5f6a7b8' } } : { result: null, context: null }),
      rules: missionHelpers,
    })[id];
    const cur = approved.evidence.find(e => e.type === 'revision' && e.current);
    expect(cur?.type === 'revision' && cur.gates.find(g => g.name.startsWith('Code review'))?.result).toBe('passed');
    expect(approved.kind).toBe('audit');
    expect(approved.stages.audit).toBe('Code review passed · CI passed on d4e5f60');
  });
});
