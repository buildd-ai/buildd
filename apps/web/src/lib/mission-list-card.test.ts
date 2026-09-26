/**
 * The missions-list card model. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionCardView, summarizeMissionForCard } from './mission-card-view';
import {
  buildMissionListCard,
  describeCadence,
  missionsHeadline,
  nextRunLabel,
  shortAgo,
  shortDuration,
  type ListMissionRow,
  type ListTaskRow,
} from './mission-list-card';

const NOW = Date.now();
let clock = NOW - 60 * 60_000;
function task(id: string, over: Partial<ListTaskRow> = {}): ListTaskRow {
  clock += 60_000;
  return { id, title: `feat(${id}): something`, status: 'pending', taskClass: 'work', mode: 'execution', createdAt: new Date(clock), workers: [], ...over };
}
const phase = (i: number, label: string) => ({ missionPhaseIndex: i, missionPhaseLabel: label });

function build(row: ListMissionRow, opts: Parameters<typeof buildMissionListCard>[3] = {}) {
  const summary = summarizeMissionForCard(row, { now: NOW });
  const view = buildMissionCardView(row, { from: 'missions', now: NOW, summary });
  return buildMissionListCard(row, view, summary, { now: NOW, ...opts });
}

describe('buildMissionListCard — running mission', () => {
  const row: ListMissionRow = {
    id: 'm1', title: 'Example mission', status: 'active', createdAt: new Date(NOW - 3600_000),
    goalCriteria: [{}, {}, {}, {}],
    goalCriteriaState: { criteria: [{ verdict: 'pass' }, { verdict: 'fail' }] },
    tasks: [
      task('plan0', { title: 'Mission: Example mission', mode: 'planning', kind: 'coordination', status: 'completed', workers: [{ status: 'completed' }] }),
      task('db', { ...phase(0, 'Foundations'), status: 'completed', workers: [{ status: 'completed', prNumber: 11, prUrl: 'https://example.test/pr/11', mergedAt: new Date() }] }),
      task('fx', { ...phase(0, 'Foundations'), status: 'completed', workers: [{ status: 'completed', prNumber: 13, prUrl: 'https://example.test/pr/13', prLifecycleStatus: 'ci_running' }] }),
      task('api', { ...phase(1, 'Product'), status: 'in_progress', roleSlug: 'builder', workers: [{ id: 'w-api', status: 'running', startedAt: new Date(NOW - 11 * 60_000) }] }),
      task('docs', { ...phase(1, 'Product'), roleSlug: 'writer' }),
    ],
  };
  const card = build(row, {
    roleColors: new Map([['builder', '#123456']]),
    progressByWorker: new Map([['w-api', 65]]),
  });

  it('groups cells by phase with scope labels, the orchestrator row as Plan', () => {
    expect(card.phases.map(p => p.label)).toEqual(['Plan', 'Foundations', 'Product']);
    expect(card.phases[0].cells.map(c => c.label)).toEqual(['plan']);
    expect(card.phases[1].cells.map(c => c.label)).toEqual(['db', 'fx']);
    expect(card.phases[1]).toMatchObject({ done: 1, total: 2 });
  });

  it('splits a CI-pending PR (in_ci) from a working agent (running, with progress)', () => {
    const cells = card.phases.flatMap(p => p.cells);
    expect(cells.find(c => c.taskId === 'fx')?.state).toBe('in_ci');
    expect(cells.find(c => c.taskId === 'api')).toMatchObject({ state: 'running', fill: 0.65 });
    expect(card.counts).toMatchObject({ done: 2, total: 5, inCi: 1, running: 1, queued: 1 });
  });

  it('reads the single status word, live dots in the role colour, criteria pips', () => {
    expect(card.kind).toBe('active');
    expect(card.status).toEqual({ label: 'Running', tone: 'accent' });
    expect(card.live.dots).toEqual([{ roleSlug: 'builder', color: '#123456' }]);
    expect(card.elapsedMin).toBe(11);
    expect(card.criteria).toEqual({ passed: 1, total: 4 });
    expect(card.sentence).toBeNull();
  });

  it('links cells into the mission, never to a bare task page', () => {
    for (const c of card.phases.flatMap(p => p.cells)) expect(c.href).toStartWith('/app/missions/m1?');
  });
});

describe('buildMissionListCard — a worker waiting on the owner', () => {
  const row: ListMissionRow = {
    id: 'm2', title: 'Example', status: 'active',
    tasks: [
      task('checkout', {
        status: 'in_progress',
        workers: [{ id: 'w-q', status: 'waiting_input', waitingFor: { type: 'question', prompt: 'Round per line or on the total?', options: ['Per line', 'Total only'] } }],
      }),
      task('api', { status: 'in_progress', workers: [{ id: 'w2', status: 'running' }] }),
    ],
  };
  const card = build(row);

  it('says Needs you and carries the inline answer strip', () => {
    expect(card.status).toEqual({ label: 'Needs you', tone: 'warning' });
    expect(card.question).toMatchObject({ taskId: 'checkout', workerId: 'w-q', label: 'checkout', options: ['Per line', 'Total only'] });
    expect(card.counts.needsYou).toBe(1);
  });
});

describe('buildMissionListCard — recurring, held and done', () => {
  it('a recurring mission is Idle between ticks, with its cadence, runs and last summary', () => {
    const tick = (id: string, hoursAgo: number, over: Partial<ListTaskRow> = {}) =>
      task(id, { mode: 'planning', kind: 'coordination', scheduleId: 's1', status: 'completed', createdAt: new Date(NOW - hoursAgo * 3600_000), result: { summary: `Tick ${id} summary. More detail.` }, ...over });
    const row: ListMissionRow = {
      id: 'm3', title: 'Keep dependencies current', status: 'active',
      schedule: { id: 's1', cronExpression: '0 */6 * * *', nextRunAt: new Date(NOW + 9 * 60_000), totalRuns: 47 },
      tasks: [tick('a', 18), tick('b', 12, { result: null }), tick('c', 6)],
    };
    const card = build(row);
    expect(card.kind).toBe('recurring');
    expect(card.status.label).toBe('Idle');
    expect(card.recurring).toMatchObject({ cadence: 'every 6h', totalRuns: 47, lastSummary: 'Tick c summary' });
    expect(card.recurring!.runs.map(r => r.state)).toEqual(['ok', 'ok', 'ok']);
    expect(card.recurring!.nextMins).toBe(9);
  });

  it('a held mission is Held, with its ready work', () => {
    const row: ListMissionRow = {
      id: 'm4', title: 'Spec first', status: 'paused', isHeld: true,
      tasks: [task('spec', { roleSlug: 'writer' })],
    };
    const card = build(row);
    expect(card.kind).toBe('held');
    expect(card.status).toEqual({ label: 'Held', tone: 'warning' });
    expect(card.held).toMatchObject({ ready: 1, roles: ['writer'] });
  });

  it('a completed mission is a done row with PRs, fixes and duration', () => {
    const row: ListMissionRow = {
      id: 'm5', title: 'Shipped', status: 'completed',
      createdAt: new Date(NOW - 3 * 3600_000), completedAt: new Date(NOW - 3600_000),
      tasks: [
        task('a', { status: 'completed', workers: [{ status: 'completed', prNumber: 1, prUrl: 'https://example.test/pr/1', mergedAt: new Date() }] }),
        task('a-fix', { taskClass: 'attempt', parentTaskId: 'a', status: 'completed' }),
        task('b', { status: 'completed', workers: [{ status: 'completed', prNumber: 2, prUrl: 'https://example.test/pr/2', prLifecycleStatus: 'merged' }] }),
      ],
    };
    const card = build(row);
    expect(card.kind).toBe('done');
    expect(card.done).toMatchObject({ prs: 2, fixes: 1, durationMs: 2 * 3600_000 });
    expect(card.elapsedMin).toBeNull();
  });
});

describe('describeCadence', () => {
  const cases: Array<[string, string]> = [
    ['0 */6 * * *', 'every 6h'],
    ['*/15 * * * *', 'every 15m'],
    ['0 * * * *', 'hourly'],
    ['0 9 * * *', 'daily'],
    ['0 9,17 * * *', '2× daily'],
    ['0 9 * * 1', 'weekly'],
    ['0 9 * * 1-5', 'weekdays'],
    ['0 9 1 * *', 'monthly'],
    ['nonsense', 'on a schedule'],
  ];
  for (const [cron, label] of cases) it(`${cron} → ${label}`, () => expect(describeCadence(cron)).toBe(label));
});

describe('shortDuration', () => {
  it('prints minutes, hours, days', () => {
    expect(shortDuration(37 * 60_000)).toBe('37m');
    expect(shortDuration(5 * 3600_000)).toBe('5h');
    expect(shortDuration(3 * 86_400_000)).toBe('3d');
    expect(shortDuration(24 * 3600_000)).toBe('1d');
    expect(shortDuration(null)).toBe('—');
  });
});

describe('missionsHeadline', () => {
  it('says what is running and how many agents are on it', () => {
    expect(missionsHeadline({ running: 1, liveAgents: 6, shippedToday: 0 })).toBe('1 running · 6 agents on it');
    expect(missionsHeadline({ running: 2, liveAgents: 1, shippedToday: 0 })).toBe('2 running · 1 agent on it');
    expect(missionsHeadline({ running: 1, liveAgents: 0, shippedToday: 0 })).toBe('1 running');
  });
  it('says what shipped when nothing runs', () => {
    expect(missionsHeadline({ running: 0, liveAgents: 0, shippedToday: 1 })).toBe('1 shipped today. Nothing running.');
    expect(missionsHeadline({ running: 0, liveAgents: 0, shippedToday: 0 })).toBe('Nothing running.');
  });
});

describe('shortAgo', () => {
  it('reads now, minutes, hours, days', () => {
    const now = Date.UTC(2026, 0, 10);
    expect(shortAgo(new Date(now - 10_000).toISOString(), now)).toBe('now');
    expect(shortAgo(new Date(now - 12 * 60_000).toISOString(), now)).toBe('12m');
    expect(shortAgo(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3d');
    expect(shortAgo(null, now)).toBe('');
  });
});

describe('nextRunLabel', () => {
  const now = Date.UTC(2026, 8, 26, 12, 0);
  const at = (mins: number) => new Date(now + mins * 60_000).toISOString();
  const text = (mins: number | null, tz?: string) => {
    const l = nextRunLabel(mins, mins == null ? null : at(mins), { now, timeZone: tz });
    return l ? [l.lead, l.value].filter(Boolean).join(' ') : null;
  };
  it('near runs read in minutes and hours', () => {
    expect(text(null)).toBeNull();
    expect(text(0)).toBe('due now');
    expect(text(45)).toBe('next 45m');
    expect(text(200)).toBe('next 3h 20m');
    expect(text(47 * 60)).toBe('next 47h');
  });
  it('days out read as a count of days, never thousands of hours', () => {
    expect(text(3 * 1440 + 100)).toBe('in 3 days');
    expect(text(13 * 1440)).toBe('in 13 days');
  });
  it('months out read as a date', () => {
    // 111 days after Sep 26 is Jan 15 (next year, so the year shows).
    expect(text(111 * 1440, 'UTC')).toBe('next Jan 15, 2027');
    expect(text(40 * 1440, 'UTC')).toBe('next Nov 5');
  });
});

describe('shortDuration for elapsed minutes', () => {
  it('turns 8640 minutes into days, not a wall of minutes', () => {
    expect(shortDuration(8640 * 60_000)).toBe('6d');
    expect(shortDuration(1620 * 60_000)).toBe('1d');
  });
});
