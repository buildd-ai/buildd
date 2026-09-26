import { describe, expect, it } from 'bun:test';
import {
  buildFleetSnapshot,
  homeHeadline,
  runnerIdentity,
  runnerNameFromUrl,
  startOfDayInZone,
  type FleetHeartbeatRow,
  type FleetWorkerRow,
} from './fleet-view';

const NOW = Date.UTC(2026, 0, 10, 14, 12);
const min = (m: number) => new Date(NOW - m * 60_000);

describe('runner identity', () => {
  it('reads the hostname label, else the URL host', () => {
    expect(runnerNameFromUrl('http://atlas.local:8766')).toBe('atlas');
    expect(runnerIdentity({ localUiUrl: 'http://x.local:1', environment: { labels: { hostname: 'birch', os: 'linux', arch: 'x64' } } }))
      .toEqual({ name: 'birch', machine: 'Linux · x64' });
    expect(runnerIdentity({ localUiUrl: 'http://x:1', environment: { labels: { machine: 'Mac Studio' } } }).machine).toBe('Mac Studio');
  });
});

describe('buildFleetSnapshot', () => {
  const hb = (id: string, url: string, max = 2): FleetHeartbeatRow => ({
    id, accountId: 'acct', localUiUrl: url, maxConcurrentWorkers: max, lastHeartbeatAt: new Date(NOW - 10_000),
  });
  const worker = (id: string, runner: string, over: Partial<FleetWorkerRow> = {}): FleetWorkerRow => ({
    id, accountId: 'acct', runner, status: 'running', startedAt: min(10),
    task: { id: `t-${id}`, title: `feat(${id}): something`, roleSlug: 'builder', missionId: 'm1' }, ...over,
  });
  const snap = buildFleetSnapshot(
    [hb('h1', 'http://atlas.local:8766'), hb('h2', 'http://birch.local:8766')],
    [
      worker('export', 'http://atlas.local:8766', { progress: 25 }),
      worker('money', 'http://atlas.local:8766', { status: 'completed', startedAt: min(40), completedAt: min(20), prNumber: 412 }),
      worker('checkout', 'http://birch.local:8766', { status: 'waiting_input', waitingFor: { prompt: 'Per line or total?' } }),
      worker('ghost', 'http://gone.local:1', { status: 'completed', startedAt: min(30), completedAt: min(25) }),
    ],
    { now: NOW, roles: new Map([['builder', { name: 'Builder', color: '#123456' }]]) },
  );

  it('joins workers to runners by URL, one slot per concurrent run', () => {
    expect(snap.runners.map(r => r.name)).toEqual(['atlas', 'birch']);
    const atlas = snap.runners[0];
    expect(atlas.slots).toHaveLength(2);
    expect(atlas.slots[0].lane.bars.map(b => b.label)).toEqual(['money', 'export']);
    expect(atlas.slots[0].worker).toMatchObject({ label: 'export', progress: 25, roleColor: '#123456', roleName: 'Builder' });
    expect(atlas.slots[1].worker).toBeNull();
  });

  it('an idle slot remembers its last run', () => {
    const idle = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('money', 'http://atlas.local:8766', { status: 'completed', startedAt: min(40), completedAt: min(20), prNumber: 412 })],
      { now: NOW },
    );
    expect(idle.runners[0].slots[0]).toMatchObject({ worker: null, last: { label: 'money', prNumber: 412 } });
  });

  it('a parked worker carries its question; live and capacity count the fleet', () => {
    expect(snap.runners[1].slots[0].worker?.question).toBe('Per line or total?');
    expect(snap.runners[1].slots[0].lane.bars[0].state).toBe('waiting');
    expect(snap.live).toBe(2);
    expect(snap.capacity).toBe(4);
  });

  it('drops a runner with no heartbeat unless it holds live work', () => {
    expect(snap.runners.some(r => r.name === 'gone')).toBe(false);
  });

  it('the window frames the current burst, floored to 5 minutes', () => {
    expect(snap.window.to).toBe(NOW);
    expect(snap.window.from).toBeLessThanOrEqual(NOW - 40 * 60_000);
    expect(snap.window.from % 300_000).toBe(0);
  });

  it('a run that ended hours ago does not stretch the window', () => {
    const old = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [
        worker('tick', 'http://atlas.local:8766', { status: 'completed', startedAt: min(360), completedAt: min(358) }),
        worker('api', 'http://atlas.local:8766', { startedAt: min(12) }),
      ],
      { now: NOW },
    );
    expect(old.window.from).toBeGreaterThanOrEqual(NOW - 35 * 60_000);
  });

  it('a fleet that started two minutes ago fills the chart, not its right edge', () => {
    const fresh = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('api', 'http://atlas.local:8766', { startedAt: min(2) })],
      { now: NOW },
    );
    // At most ~12 minutes of axis for 2 minutes of work (the old floor was 30).
    expect(NOW - fresh.window.from).toBeLessThanOrEqual(12 * 60_000);
    expect(fresh.window.from).toBeLessThan(min(2).getTime());
  });

  it('an older burst starts just before its earliest bar', () => {
    const s = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('api', 'http://atlas.local:8766', { startedAt: min(47) })],
      { now: NOW },
    );
    expect(s.window.from).toBeLessThan(min(47).getTime());
    expect(s.window.from).toBeGreaterThanOrEqual(min(55).getTime());
  });

  it('slots follow SlotLanes: overlap opens a slot, a finished slot is reused', () => {
    const s2 = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766', 2)],
      [
        worker('a', 'http://atlas.local:8766', { status: 'completed', startedAt: min(30), completedAt: min(20) }),
        worker('b', 'http://atlas.local:8766', { startedAt: min(25) }),
        worker('c', 'http://atlas.local:8766', { startedAt: min(15) }),
      ],
      { now: NOW },
    );
    const lanes = s2.runners[0].slots.map(sl => sl.lane.bars.map(b => b.label));
    expect(lanes).toEqual([['a', 'c'], ['b']]);
  });
});

describe('homeHeadline', () => {
  const text = (p: ReturnType<typeof homeHeadline>) => p.map(x => x.text).join('');
  it('says how many agents work and how many things need you', () => {
    expect(text(homeHeadline({ live: 5, needsYou: 2 }))).toBe('5 agents working. 2 need you.');
    expect(text(homeHeadline({ live: 6, needsYou: 1 }))).toBe('6 agents working. 1 needs you.');
    expect(text(homeHeadline({ live: 1, needsYou: 0 }))).toBe('1 agent working. Nothing needs you.');
  });
  it('an idle fleet names what just shipped', () => {
    const parts = homeHeadline({ live: 0, needsYou: 1, shipped: 'Example mission' });
    expect(text(parts)).toBe('Fleet idle. Example mission shipped.');
    expect(parts.find(p => p.tone === 'success')?.text).toBe('shipped');
  });
});

describe('startOfDayInZone', () => {
  it('is midnight in the team zone', () => {
    const t = Date.UTC(2026, 0, 10, 20, 30, 15); // 14:30 in Chicago (UTC-6)
    expect(new Date(startOfDayInZone(t, 'America/Chicago')).toISOString()).toBe('2026-01-10T06:00:00.000Z');
    expect(new Date(startOfDayInZone(t, null)).toISOString()).toBe('2026-01-10T00:00:00.000Z');
    expect(new Date(startOfDayInZone(t, 'Not/AZone')).toISOString()).toBe('2026-01-10T00:00:00.000Z');
  });
});
