/**
 * Activity: live work with context (spec 9430a28f R-1, R-2, R-3, AC-1, AC-2).
 * Now groups live work by mission with the root outcome, the current task and
 * the last meaningful transition; derived reviews and repairs fold beneath the
 * work they came from, however many generations deep; newness is an attribute
 * of the one row or group, never a second list.
 */
import { describe, expect, it } from 'bun:test';
import * as rules from '@buildd/core/mission-helpers';
import {
  ACTIVITY_FIXTURE_NOW, CHAIN_ROOT, NEW_MISSION, activityContextFixture, fiveGenerationChain, newMissionTasks,
} from '@/app/app/dev/fixtures/activity-delivery-fixtures';
import { projectMissionDelivery } from './delivery-projection';
import { NEW_WINDOW_MS, buildActivityEpisodes, buildActivityHistory, buildActivityNow, type ActivityTaskInput } from './activity-delivery';

const NOW = ACTIVITY_FIXTURE_NOW;
const at = (hhmm: string) => Date.parse(`2026-10-08T${hhmm}:00.000Z`);
const rowsOf = (n: ReturnType<typeof buildActivityNow>) => n.groups.flatMap(g => [...g.rows, ...g.hiddenWaitingRows]);
const missionOf = (id: string, title: string, tasks: ActivityTaskInput[], createdAt?: string) => ({
  ...projectMissionDelivery({ id, title, status: 'active', href: `/app/missions/${id}`, tasks: tasks.filter(t => t.missionId === id) }, rules),
  createdAt: createdAt ?? null,
});

describe('R-2 / AC-2: a five-generation review/repair chain reads as one outcome', () => {
  const chain = fiveGenerationChain({ id: 'm-chain', title: 'Chain mission' });
  const n = buildActivityNow({ tasks: chain, missions: [missionOf('m-chain', 'Chain mission', chain)], rules, now: NOW });

  it('is one row: no attempt of any generation gets a row of its own', () => {
    expect(rowsOf(n).map(r => r.id)).toEqual([CHAIN_ROOT]);
  });

  it('every generation folds beneath it, oldest first, each linking to its own task and its real parent', () => {
    const row = rowsOf(n)[0];
    expect(row.children.map(c => c.id)).toEqual(['fx-chain-g1', 'fx-chain-g2', 'fx-chain-g3', 'fx-chain-g4', 'fx-chain-g5']);
    expect(row.children.map(c => c.generation)).toEqual([1, 2, 3, 4, 5]);
    expect(row.children.map(c => c.role)).toEqual(['review', 'repair', 'review', 'repair', 'repair']);
    const byId = new Map(chain.map(t => [t.id, t]));
    for (const c of row.children) {
      expect(c.href).toBe(`/app/tasks/${c.id}`);
      expect(c.parent.id).toBe(byId.get(c.id)!.parentTaskId!);
      expect(c.parent.href).toBe(`/app/tasks/${c.parent.id}`);
      expect(c.missionHref).toBe('/app/missions/m-chain');
    }
    expect(row.children.filter(c => c.live).map(c => c.id)).toEqual(['fx-chain-g5']);
  });

  it('its repairs past the first generation are evidence on the one row', () => {
    const repairs = rowsOf(n)[0].evidence.filter(e => e.type === 'repair');
    expect(repairs).toHaveLength(3);
  });

  it('standalone, it stays one recognizable row in the standalone group, with no mission link', () => {
    const solo = fiveGenerationChain(null);
    const s = buildActivityNow({ tasks: solo, missions: [], rules, now: NOW });
    expect(s.groups.map(g => g.missionId)).toEqual([null]);
    expect(rowsOf(s).map(r => r.id)).toEqual([CHAIN_ROOT]);
    expect(rowsOf(s)[0].children.every(c => c.missionHref === null)).toBe(true);
    expect(rowsOf(s)[0].delivery.repairRounds).toBe(3);
  });

  it('a standalone task with no derived work has no children', () => {
    const s = buildActivityNow({ tasks: newMissionTasks().map(t => ({ ...t, missionId: null, missionTitle: null })), missions: [], rules, now: NOW });
    expect(rowsOf(s).every(r => r.children.length === 0)).toBe(true);
  });

  it('History and Mission History fold the whole chain into one episode', () => {
    const merged = fiveGenerationChain(null).map(t => t.id === CHAIN_ROOT
      ? { ...t, workers: t.workers.map(w => ({ ...w, mergedAt: '2026-10-08T11:08:00.000Z', prLifecycleStatus: 'merged' })) }
      : t.id === 'fx-chain-g5' ? { ...t, status: 'completed', workers: [{ status: 'completed', startedAt: '2026-10-08T10:55:00.000Z', completedAt: '2026-10-08T11:05:00.000Z', lastCommitSha: 'dd00000004' }] } : t);
    const h = buildActivityHistory({ tasks: merged, missions: [], rules });
    expect(h.map(e => e.id)).toEqual([CHAIN_ROOT]);
    expect(h[0].steps.map(s => s.text)).toContain('Automatic repair 3: review notes');
    expect(buildActivityEpisodes({ tasks: merged, missions: [], rules }).map(e => e.id)).toEqual([CHAIN_ROOT]);
  });
});

describe('R-1: Now shows the root outcome, the current task and the last meaningful transition', () => {
  const f = activityContextFixture();
  const group = (id: string | null) => f.now.groups.find(g => g.missionId === id)!;

  it('groups by mission: the group is the root outcome, the row the current task', () => {
    expect(f.now.groups.map(g => g.missionId).sort()).toEqual(['fx-flaky', 'fx-new', null].sort() as Array<string | null>);
    expect(group('fx-new').title).toBe(NEW_MISSION.title);
    expect(group('fx-new').current).toMatchObject({ id: 'fx-new-1', href: '/app/tasks/fx-new-1' });
  });

  it('the transition is the last canonical event, with its time: not a worker heartbeat', () => {
    const row = rowsOf(f.now).find(r => r.id === 'fx-new-1')!;
    // The live worker's updated_at is 11:08; its run started at 11:04.
    expect(row.transition).toEqual({ at: at('11:04'), text: 'Build started', tone: 'ink' });
    const chain = rowsOf(f.now).find(r => r.id === CHAIN_ROOT)!;
    expect(chain.transition?.at).toBe(at('10:55'));
    expect(chain.transition?.text).toBe('Automatic repair 3: review notes');
  });

  it('the group carries the transition of its current task', () => {
    expect(group('fx-new').current?.transition?.text).toBe('Build started');
  });
});

describe('R-3 / AC-1: newness is an attribute, never a duplicate list', () => {
  const f = activityContextFixture();

  it('a newly created mission that started at once is one group, marked new, with its created time', () => {
    const g = f.now.groups.filter(x => x.missionId === NEW_MISSION.id);
    expect(g).toHaveLength(1);
    expect(g[0].isNew).toBe(true);
    expect(g[0].createdAt).toBe(Date.parse(NEW_MISSION.createdAt));
    const ids = rowsOf(f.now).map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('created time is kept apart from last activity', () => {
    const row = rowsOf(f.now).find(r => r.id === 'fx-new-1')!;
    expect(row.isNew).toBe(true);
    expect(row.createdAt).toBe(at('11:03'));
    expect(row.transition!.at).not.toBe(row.createdAt);
  });

  it('older work is not new', () => {
    expect(f.now.groups.find(g => g.missionId === 'fx-flaky')!.isNew).toBe(false);
    expect(rowsOf(f.now).find(r => r.id === CHAIN_ROOT)!.isNew).toBe(false);
    expect(NEW_WINDOW_MS).toBeGreaterThan(0);
    expect(NOW - at('09:00')).toBeGreaterThan(NEW_WINDOW_MS);
  });

  it('History carries the mission\'s creation as its own event, and still no in-flight delivery', () => {
    const created = f.history.filter(e => e.event === 'created' && e.missionId === NEW_MISSION.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: `created:${NEW_MISSION.id}`, href: `/app/missions/${NEW_MISSION.id}`, missionId: NEW_MISSION.id,
      title: NEW_MISSION.title, at: Date.parse(NEW_MISSION.createdAt),
    });
    expect(created[0].steps.map(s => s.text)).toEqual(['Mission created']);
    // Deliveries in History are finished ones only.
    expect(f.history.filter(e => !e.event).every(e => e.kind === 'landed' || e.kind === 'notlanded')).toBe(true);
  });

  it('without creations, History has no creation events', () => {
    expect(buildActivityHistory({ tasks: f.tasks, missions: f.missions, rules }).some(e => e.event)).toBe(false);
  });
});
