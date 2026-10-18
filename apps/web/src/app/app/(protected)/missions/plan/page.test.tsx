import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let enabled = true;
let calibrated = false;
const loadMissionPlan = mock(async () => ({ inputs: [], plans: new Map() }));
mock.module('next/navigation', () => ({ redirect: (href: string) => { throw new Error(`redirect:${href}`); } }));
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'test-user' }) }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => ['test-team'], resolveActiveTeamId: async () => 'test-team' }));
mock.module('@buildd/core/task-estimate-source', () => ({ taskEstimatesEnabled: async () => enabled }));
mock.module('@buildd/core/task-estimate-rollout', () => ({ taskEstimatesDefaultOn: () => calibrated }));
mock.module('@/lib/mission-plan-source', () => ({ loadMissionPlan }));
const { default: MissionPlanPage } = await import('./page');

beforeEach(() => { enabled = true; calibrated = false; loadMissionPlan.mockClear(); });
const render = async () => renderToStaticMarkup(await MissionPlanPage({ searchParams: Promise.resolve({}) }));

describe('mission forecast calibration safety', () => {
  test('default availability cannot expose uncalibrated mission dates', async () => {
    const html = await render();
    expect(html).toContain('Mission forecasts are unavailable while estimates are being calibrated.');
    expect(html).not.toContain('/app/settings');
    expect(loadMissionPlan).not.toHaveBeenCalled();
  });
  test('legacy opt-out remains unavailable even after calibration passes', async () => {
    enabled = false; calibrated = true;
    expect(await render()).toContain('plan-off');
    expect(loadMissionPlan).not.toHaveBeenCalled();
  });
  test('only a calibrated and enabled team can load forecasts', async () => {
    calibrated = true;
    expect(await render()).toContain('plan-lede');
    expect(loadMissionPlan).toHaveBeenCalledTimes(1);
  });
});
