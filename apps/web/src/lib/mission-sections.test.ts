import { describe, expect, it } from 'bun:test';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from './delivery-projection';
import type { PortfolioRow } from './mission-portfolio';
import { buildMissionSections, sectionOf } from './mission-sections';

const PR = 'https://github.com/o/r/pull/1';
const task = (id: string, over: Partial<MissionTaskRow> = {}): MissionTaskRow => ({ id, title: id, status: 'pending', taskClass: 'work', workers: [], ...over });
const audit = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_pending' }] });
const ciFailed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] });
const closed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });
const merged = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, mergedAt: '2026-10-01', prLifecycleStatus: 'merged' }] });
const asking = (id: string) => task(id, { status: 'in_progress', workers: [{ status: 'waiting_input' }] });

function row(id: string, tasks: MissionTaskRow[], over: Partial<PortfolioRow> & { isHeld?: boolean; integrationBranch?: boolean } = {}): PortfolioRow {
  const { isHeld = false, integrationBranch = false, ...rest } = over;
  return {
    delivery: projectMissionDelivery({ id, title: id, status: 'active', href: `/app/missions/${id}`, isHeld, integrationBranch, tasks }, missionHelpers),
    status: 'active', workspaceId: 'w', workspaceName: 'w', priority: 0, liveAgents: 0,
    lastAdvancedAt: 1000, completedAt: null, nextScanMins: null, ...rest,
  };
}

describe('mission sections', () => {
  it('splits by what the mission needs, dropping empty sections', () => {
    const s = buildMissionSections([row('a', [audit('t')]), row('b', [asking('t')]), row('c', [task('t')])]);
    expect(s.map(x => x.key)).toEqual(['needs', 'motion', 'waiting']);
    expect(buildMissionSections([row('a', [audit('t')])]).map(x => x.key)).toEqual(['motion']);
  });

  it('Needs you is oldest first', () => {
    const s = buildMissionSections([
      row('new', [asking('t')], { lastAdvancedAt: 5000 }),
      row('old', [closed('t')], { lastAdvancedAt: 1000 }),
      row('none', [asking('t')], { lastAdvancedAt: null }),
    ]);
    expect(s[0].rows.map(r => r.delivery.id)).toEqual(['old', 'new', 'none']);
    expect(s[0].order).toBe('oldest first');
  });

  it('In motion puts repairing first, then the quietest', () => {
    const s = buildMissionSections([
      row('fresh', [audit('t')], { lastAdvancedAt: 9000 }),
      row('quiet', [audit('t')], { lastAdvancedAt: 1000 }),
      row('fix', [ciFailed('t')], { lastAdvancedAt: 8000 }),
    ]);
    expect(s[0].rows.map(r => r.delivery.id)).toEqual(['fix', 'quiet', 'fresh']);
    expect(s[0].order).toBe('slipping first');
  });

  it('Waiting runs next to start first: queued, not planned, held', () => {
    const s = buildMissionSections([
      row('held', [task('t')], { isHeld: true }),
      row('plan', []),
      row('queued', [task('t')]),
    ]);
    expect(s[0].rows.map(r => r.delivery.id)).toEqual(['queued', 'plan', 'held']);
    expect(s[0].order).toBe('next to start first');
    expect(sectionOf(s[0].rows[0])).toBe('waiting');
  });

  it('an open mission whose every task landed is On dev, criteria pending, not In motion', () => {
    const s = buildMissionSections([row('done', [merged('a'), merged('b')]), row('a', [audit('t')])]);
    expect(s.map(x => x.key)).toEqual(['motion', 'landed']);
    expect(s[1].label).toBe('On dev, criteria pending');
    expect(sectionOf(s[1].rows[0])).toBe('landed');
  });

  it('a mission-branch mission whose tasks all landed is still landing, not on dev', () => {
    const s = buildMissionSections([row('mb', [merged('a')], { integrationBranch: true })]);
    expect(s.map(x => x.key)).toEqual(['motion']);
  });

  it('carries no per-section destinations sentence', () => {
    const s = buildMissionSections([row('a', [audit('t')])]);
    expect('destinations' in s[0]).toBe(false);
  });
});
