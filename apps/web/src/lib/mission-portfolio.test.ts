/**
 * The Missions portfolio's sort, filter and count rules over the shared
 * delivery projection. Fixtures are illustrative.
 */
import { describe, expect, it } from 'bun:test';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from './delivery-projection';
import {
  COMPLETED_HISTORY_WINDOW_MS,
  filterPortfolio,
  portfolioCounts,
  portfolioFilterCounts,
  sortPortfolio,
  splitPortfolio,
  type PortfolioRow,
} from './mission-portfolio';

const NOW = Date.UTC(2026, 9, 8, 12);
const PR = 'https://github.com/o/r/pull/1';

function task(id: string, over: Partial<MissionTaskRow> = {}): MissionTaskRow {
  return { id, title: `feat: ${id}`, status: 'pending', taskClass: 'work', workers: [], ...over };
}
const landedTask = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01', prLifecycleStatus: 'merged' }] });
const buildingTask = (id: string) => task(id, { status: 'in_progress', workers: [{ status: 'running' }] });
const auditTask = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_pending' }] });
// Closed unmerged after the supersession scan ran: a person decides.
const notLandedTask = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed', supersessionScan: { scannedAt: '2026-10-08T10:00:00Z', suggestion: null } }] });
// Closed unmerged with the scan still owed: Buildd is reconciling it.
const reconcilingTask = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });

function row(id: string, tasks: MissionTaskRow[], over: Partial<PortfolioRow> & { status?: string; isHeld?: boolean } = {}): PortfolioRow {
  const { status = 'active', isHeld = false, ...rest } = over;
  return {
    delivery: projectMissionDelivery({ id, title: `Mission ${id}`, status, href: `/app/missions/${id}`, isHeld, tasks }, missionHelpers),
    status,
    workspaceId: 'ws1',
    workspaceName: 'web',
    priority: 0,
    liveAgents: tasks.reduce((n, t) => n + (t.workers ?? []).filter(w => w.status === 'running').length, 0),
    lastAdvancedAt: NOW - 60_000,
    completedAt: null,
    nextScanMins: null,
    ...rest,
  };
}

const building = row('build', [landedTask('a'), buildingTask('b'), task('c')], { lastAdvancedAt: NOW - 5 * 60_000, priority: 1 });
const audit = row('audit', [landedTask('a'), landedTask('b'), auditTask('c')], { lastAdvancedAt: NOW - 30 * 60_000, workspaceId: 'ws2', workspaceName: 'core' });
const broken = row('broken', [landedTask('a'), notLandedTask('b')], { lastAdvancedAt: NOW - 2 * 3_600_000 });
const waiting = row('waiting', [task('a'), task('b')], { lastAdvancedAt: NOW - 9 * 3_600_000, priority: 5 });
const held = row('held', [task('a')], { isHeld: true, status: 'paused', lastAdvancedAt: null });
const onDev = row('on-dev', [landedTask('a'), landedTask('b')]);
const doneRecent = row('done-recent', [landedTask('a')], { status: 'completed', completedAt: NOW - 3_600_000 });
const doneOld = row('done-old', [landedTask('a')], { status: 'completed', completedAt: NOW - 30 * 86_400_000 });
const ALL = [building, audit, broken, waiting, held, doneRecent, doneOld];

describe('splitPortfolio', () => {
  it('separates open missions from completed history, recent first', () => {
    const { open, recentDone, olderDone } = splitPortfolio(ALL, NOW);
    expect(open.map(r => r.delivery.id).sort()).toEqual(['audit', 'broken', 'build', 'held', 'waiting']);
    expect(recentDone.map(r => r.delivery.id)).toEqual(['done-recent']);
    expect(olderDone.map(r => r.delivery.id)).toEqual(['done-old']);
    expect(COMPLETED_HISTORY_WINDOW_MS).toBe(7 * 86_400_000);
  });

  it('files archived missions with history, so the open list matches the open counter', () => {
    const archived = row('archived', [landedTask('a')], { status: 'archived', completedAt: null });
    const rows = [...ALL, archived];
    const { open, recentDone, olderDone } = splitPortfolio(rows, NOW);
    expect(open.map(r => r.delivery.id)).not.toContain('archived');
    expect(olderDone.map(r => r.delivery.id)).toContain('archived');
    expect(recentDone.map(r => r.delivery.id)).not.toContain('archived');
    expect(open.length).toBe(portfolioCounts(rows, { live: 0, max: 0 }).openMissions);
  });
});

describe('sortPortfolio', () => {
  const ids = (rows: PortfolioRow[]) => rows.map(r => r.delivery.id);
  const open = [held, waiting, building, audit, broken];

  it('attention: exceptions, then audit, then build, then waiting and held', () => {
    expect(ids(sortPortfolio(open, 'attention'))).toEqual(['broken', 'audit', 'build', 'waiting', 'held']);
  });

  it('recent: most recently advanced first; never-advanced last', () => {
    expect(ids(sortPortfolio(open, 'recent'))).toEqual(['build', 'audit', 'broken', 'waiting', 'held']);
  });

  it('closest: highest verified landed share first', () => {
    // audit 2/3, broken 1/2, build 1/3, waiting 0/2, held 0/1 (tiebreak by stage then id)
    expect(ids(sortPortfolio(open, 'closest'))).toEqual(['audit', 'broken', 'build', 'held', 'waiting']);
  });

  it('priority: higher mission priority first, attention breaks ties', () => {
    expect(ids(sortPortfolio(open, 'priority'))).toEqual(['waiting', 'build', 'broken', 'audit', 'held']);
  });

  it('does not mutate its input', () => {
    const copy = [...open];
    sortPortfolio(open, 'attention');
    expect(open).toEqual(copy);
  });
});

describe('filterPortfolio', () => {
  const open = [building, audit, broken, waiting, held];
  const ids = (rows: PortfolioRow[]) => rows.map(r => r.delivery.id).sort();

  it('status filters are the list sections, read from the projection', () => {
    expect(ids(filterPortfolio(open, { status: 'all' }))).toEqual(ids(open));
    expect(ids(filterPortfolio(open, { status: 'needs' }))).toEqual(['broken']);
    expect(ids(filterPortfolio(open, { status: 'motion' }))).toEqual(['audit', 'build']);
    expect(ids(filterPortfolio(open, { status: 'waiting' }))).toEqual(['held', 'waiting']);
    expect(ids(filterPortfolio([...open, onDev], { status: 'landed' }))).toEqual(['on-dev']);
  });

  it('a closed PR still being reconciled filters as In motion, not Needs you', () => {
    const rec = row('reconciling', [landedTask('a'), reconcilingTask('b')]);
    expect(ids(filterPortfolio([rec], { status: 'needs' }))).toEqual([]);
    expect(ids(filterPortfolio([rec], { status: 'motion' }))).toEqual(['reconciling']);
  });

  it('search matches title and workspace, case-insensitively', () => {
    expect(ids(filterPortfolio(open, { q: 'mission AUD' }))).toEqual(['audit']);
    expect(ids(filterPortfolio(open, { q: 'core' }))).toEqual(['audit']);
    expect(filterPortfolio(open, { q: '  ' })).toHaveLength(open.length);
  });

  it('workspace filter narrows to one workspace', () => {
    expect(ids(filterPortfolio(open, { workspaceId: 'ws2' }))).toEqual(['audit']);
  });

  it('team-level missions stay in every workspace view', () => {
    const teamLevel = { ...waiting, workspaceId: null, workspaceName: null };
    expect(ids(filterPortfolio([audit, teamLevel], { workspaceId: 'ws2' }))).toEqual(['audit', 'waiting']);
  });

  it('counts each status filter on the same rows', () => {
    expect(portfolioFilterCounts([...open, onDev])).toEqual({ all: 6, needs: 1, motion: 2, waiting: 2, landed: 1 });
  });
});

describe('portfolioCounts', () => {
  it('open, executing and agent slots are three different numbers', () => {
    const c = portfolioCounts(ALL, { live: 3, max: 8 });
    expect(c.openMissions).toBe(5);
    expect(c.executingMissions).toBe(1);
    expect(c.slots).toEqual({ used: 3, total: 8 });
  });
});
