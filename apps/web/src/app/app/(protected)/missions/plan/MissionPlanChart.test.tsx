import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import MissionPlanChart from './MissionPlanChart';
import { planAxis, planMissions, type PlanMissionInput, type ReleasePlan } from '@/lib/mission-plan';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 7, 12);
const FRI = Date.UTC(2026, 9, 9, 15);
const t = (id: string, p: object = {}) => ({ id, status: 'pending', dependsOn: [], startedAt: null, endedAt: null, p50Minutes: 600, p80Minutes: 1200, ...p });
const m = (id: string, p: Partial<PlanMissionInput> = {}): PlanMissionInput => ({
  id, title: `M ${id}`, href: `/app/missions/${id}`, workspaceId: 'w', blocked: null, dependsOnMissionId: null, tasks: [t('t')], ...p,
});

describe('MissionPlanChart', () => {
  const plans = new Map<string, ReleasePlan>([['w', { mode: 'cuts', cuts: [FRI, FRI + 7 * DAY], latestVersion: 'v0.301.0' }]]);
  const rows = planMissions([
    m('a', { tasks: [t('t', { status: 'in_progress', startedAt: NOW - 3_600_000 })] }),
    m('b', { blocked: 'you' }),
    m('c', { dependsOnMissionId: 'a' }),
  ], NOW, plans);
  const axis = planAxis(rows, [FRI], NOW);
  const html = renderToStaticMarkup(<MissionPlanChart rows={rows} axis={axis} cuts={[FRI]} now={NOW} />);

  it('one linked row per mission, each to its Flow', () => {
    expect(html.match(/data-testid="plan-row"/g)).toHaveLength(3);
    expect(html).toContain('href="/app/missions/a?layout=flow"');
  });

  it('draws weekends, cuts, a solid so-far bar, a hatched estimate and an elbow', () => {
    for (const id of ['plan-weekend', 'plan-cut', 'plan-so-far', 'plan-estimate', 'plan-elbow', 'plan-long-run']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
  });

  it('a person-blocked mission has no estimate bar and says why', () => {
    expect(html).toContain('waiting on you');
    const blocked = html.split('<li').find(s => s.includes('M b'))!;
    expect(blocked).not.toContain('plan-estimate');
  });

  it('names the dependency and the release fit in the right column', () => {
    expect(html).toContain('after M a');
    expect(html).toMatch(/Fri → v0\.302/);
  });
});
