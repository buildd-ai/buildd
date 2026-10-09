import { describe, expect, it } from 'bun:test';
import * as missionHelpers from '@buildd/core/mission-helpers';
import { projectMissionDelivery, type MissionTaskRow } from './delivery-projection';
import type { PortfolioRow } from './mission-portfolio';
import { buildMissionSections, describeDestinations, sectionOf } from './mission-sections';

const PR = 'https://github.com/o/r/pull/1';
const task = (id: string, over: Partial<MissionTaskRow> = {}): MissionTaskRow => ({ id, title: id, status: 'pending', taskClass: 'work', workers: [], ...over });
const audit = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_pending' }] });
const ciFailed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'ci_failed' }] });
const closed = (id: string) => task(id, { status: 'completed', workers: [{ status: 'completed', prUrl: PR, prLifecycleStatus: 'closed' }] });
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
      row('old', [asking('t')], { lastAdvancedAt: 1000 }),
      row('none', [asking('t')], { lastAdvancedAt: null }),
    ]);
    expect(s[0].rows.map(r => r.delivery.id)).toEqual(['old', 'new', 'none']);
    expect(s[0].order).toBe('oldest first');
  });

  it('a closed unmerged PR is reconciled in motion, not under Needs you', () => {
    const s = buildMissionSections([row('c', [closed('t')])]);
    expect(s.map(x => x.key)).toEqual(['motion']);
    expect(s[0].rows[0].delivery.exception?.text).not.toContain('t finished');
  });

  it('zero human-needed and mixed scenarios count only real asks', () => {
    const none = buildMissionSections([row('a', [closed('t')]), row('b', [audit('t')])]);
    expect(none.some(x => x.key === 'needs')).toBe(false);
    const mixed = buildMissionSections([row('a', [closed('t')]), row('b', [asking('t')]), row('c', [asking('t')])]);
    expect(mixed.find(x => x.key === 'needs')!.rows).toHaveLength(2);
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

  it('names destinations honestly and invents none', () => {
    expect(describeDestinations([row('a', [audit('t')]), row('b', [audit('t')])])).toBe('2 landing on trunk');
    expect(describeDestinations([row('a', [audit('t')], { integrationBranch: true }), row('b', [])])).toBe('1 on a mission branch, 1 not planned yet');
  });
});
