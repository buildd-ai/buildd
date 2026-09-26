import { describe, expect, it } from 'bun:test';
import {
  buildFleetSnapshot,
  fleetCapacity,
  fleetDisplayRows,
  fleetSummary,
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
    expect(atlas.slots[0].lane.bars.map(b => b.scope)).toEqual(['money', 'export']);
    expect(atlas.slots[0].lane.bars.map(b => b.label)).toEqual(['something', 'something']);
    expect(atlas.slots[0].lane.bars[0].title).toBe('feat(money): something');
    expect(atlas.slots[0].worker).toMatchObject({ label: 'export', progress: 25, roleColor: '#123456', roleName: 'Builder' });
    expect(atlas.slots[1].worker).toBeNull();
  });

  it('an idle slot remembers its last run', () => {
    const idle = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('money', 'http://atlas.local:8766', { status: 'completed', startedAt: min(40), completedAt: min(20), prNumber: 412 })],
      { now: NOW },
    );
    expect(idle.runners[0].slots[0]).toMatchObject({ worker: null, last: { label: 'something', scope: 'money', prNumber: 412 } });
    expect(idle.runners[0].slots[0].last?.at).toBe(min(20).getTime());
  });

  it("an idle slot's last run is named by the task label, never by a generic scope word", () => {
    const idle = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('x', 'http://atlas.local:8766', {
        status: 'completed', startedAt: min(40), completedAt: min(20), prNumber: 2001,
        task: { id: 't-x', title: 'fix(pr): keep the PR body in sync after a force-push', taskClass: 'attempt' },
      })],
      { now: NOW },
    );
    const last = idle.runners[0].slots[0].last!;
    expect(last.label).toBe('keep PR body');
    expect(last.label).not.toBe('pr');
    expect(last.fix).toBe(true);
  });

  it('a stored task label wins over the title heuristic', () => {
    const idle = buildFleetSnapshot(
      [hb('h1', 'http://atlas.local:8766')],
      [worker('x', 'http://atlas.local:8766', {
        status: 'completed', startedAt: min(40), completedAt: min(20),
        task: { id: 't-x', title: 'docs(specs): reconcile exports.md with the code', label: 'reconcile exports spec' },
      })],
      { now: NOW },
    );
    expect(idle.runners[0].slots[0].last?.label).toBe('reconcile exports spec');
    expect(idle.runners[0].slots[0].lane.bars[0].label).toBe('reconcile exports spec');
  });

  it('the runner name drops a .local suffix and keeps the full name for a title', () => {
    const s = buildFleetSnapshot(
      [{ ...hb('h1', 'http://studio.local:8766'), environment: { labels: { hostname: 'quill-studio-workstation.local' } } }],
      [],
      { now: NOW },
    );
    expect(s.runners[0].name).toBe('quill-studio-workstation');
  });

  it('a parked worker carries its question; live and capacity count the fleet', () => {
    expect(snap.runners[1].slots[0].worker?.question).toBe('Per line or total?');
    expect(snap.runners[1].slots[0].lane.bars[0].state).toBe('waiting');
    expect(snap.live).toBe(2);
    expect(snap.capacity).toBe(4);
  });

  it('fleetCapacity is the snapshot capacity: online heartbeats only (the Lanes band reads it too)', () => {
    const beats = [hb('h1', 'http://a:1', 2), hb('h2', 'http://b:1', 6), { ...hb('h3', 'http://c:1', 4), lastHeartbeatAt: new Date(NOW - 10 * 60_000) }];
    expect(fleetCapacity(beats, { now: NOW })).toBe(8);
    expect(buildFleetSnapshot(beats, [], { now: NOW }).capacity).toBe(fleetCapacity(beats, { now: NOW }));
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
    const lanes = s2.runners[0].slots.map(sl => sl.lane.bars.map(b => b.scope));
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

describe('fleetDisplayRows — busy slots first, idle ones folded', () => {
  const hb10: FleetHeartbeatRow = { id: 'h1', accountId: 'acct', localUiUrl: 'http://q.local:1', maxConcurrentWorkers: 10, lastHeartbeatAt: new Date(NOW - 10_000) };
  const w = (id: string, over: Partial<FleetWorkerRow>): FleetWorkerRow => ({
    id, accountId: 'acct', runner: 'http://q.local:1', status: 'running', startedAt: min(10),
    task: { id: `t-${id}`, title: `feat(${id}): something` }, ...over,
  });

  it('ten idle slots with no recent runs fold into one row', () => {
    const s = buildFleetSnapshot([hb10], [], { now: NOW });
    const rows = fleetDisplayRows(s.runners[0], { since: s.window.from });
    expect(rows).toEqual([{ kind: 'idle', count: 10, slots: s.runners[0].slots }]);
  });

  it('busy slots, then up to two recently finished ones, then the rest as a count', () => {
    const s = buildFleetSnapshot([hb10], [
      w('a', { startedAt: min(30) }),
      w('b', { status: 'completed', startedAt: min(29), completedAt: min(20) }),
      w('c', { status: 'completed', startedAt: min(28), completedAt: min(10) }),
      w('d', { status: 'completed', startedAt: min(27), completedAt: min(5) }),
      w('e', { startedAt: min(26) }),
    ], { now: NOW });
    const rows = fleetDisplayRows(s.runners[0], { since: s.window.from });
    const shown = rows.filter(r => r.kind === 'slot').map(r => (r.kind === 'slot' ? r.slot.worker?.label ?? r.slot.last?.scope : null));
    // Busy (a, e) first, then the two most recent idle (d, then c); b and the empty slots fold.
    expect(shown).toEqual(['a', 'e', 'd', 'c']);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'idle', count: 6 });
  });

  it('a single leftover idle slot is shown, not folded', () => {
    const hb2 = { ...hb10, maxConcurrentWorkers: 2 };
    const s = buildFleetSnapshot([hb2], [w('a', {})], { now: NOW });
    const rows = fleetDisplayRows(s.runners[0], { since: s.window.from });
    expect(rows.map(r => r.kind)).toEqual(['slot', 'slot']);
  });
});

describe('fleetSummary', () => {
  it('counts busy slots and names the most recent finished run', () => {
    const s = buildFleetSnapshot(
      [{ id: 'h1', accountId: 'acct', localUiUrl: 'http://q.local:1', maxConcurrentWorkers: 10, lastHeartbeatAt: new Date(NOW - 10_000) }],
      [
        { id: 'x', accountId: 'acct', runner: 'http://q.local:1', status: 'completed', startedAt: min(90), completedAt: min(88), task: { id: 't1', title: 'feat(old): older run' } },
        { id: 'y', accountId: 'acct', runner: 'http://q.local:1', status: 'completed', startedAt: min(30), completedAt: min(25), task: { id: 't2', title: 'docs(specs): reconcile exports', label: 'reconcile exports spec' } },
      ],
      { now: NOW },
    );
    expect(fleetSummary(s)).toEqual({
      busy: 0, slots: 10, online: 1, runnerNames: ['q'],
      last: { label: 'reconcile exports spec', at: min(25).getTime(), failed: false },
    });
  });

  it('an empty fleet has no last run', () => {
    expect(fleetSummary({ runners: [], live: 0, capacity: 0, window: { from: 0, to: 0 } }).last).toBeNull();
  });
});
