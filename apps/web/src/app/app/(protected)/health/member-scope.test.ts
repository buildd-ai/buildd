import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * A member's Health shows their own work and the runners they can use. What
 * only admins act on or see (team-wide spend, pausing new starts) is loaded
 * only for people holding the permission, so it never reaches a member's
 * browser. Operator tools stay behind isPlatformOperator (operator/page.tsx).
 */
const read = (rel: string) => readFileSync(resolve(import.meta.dir, rel), 'utf8');

describe("a member's Health", () => {
  it('loads the team budget forecast only with view_team_usage', () => {
    const data = read('_lib/health-data.ts');
    expect(data).toMatch(/can\(\{ kind: 'user', userId \}, 'view_team_usage', activeTeamId\)/);
    expect(data).toMatch(/seesTeamSpend \? getBudgetForecast/);
    expect(data).not.toMatch(/need\('budgetForecast'\) \? getBudgetForecast/);
  });

  it('offers Pause new starts only for workspaces the viewer may manage', () => {
    const page = read('runners/page.tsx');
    expect(page).toContain("'manage_workspace_settings'");
  });

  it("shows a member's Usage as their own tasks, without the team's monthly spend or hosted runner month", () => {
    const loader = read('usage/_lib/load-usage-view.ts');
    expect(loader).toMatch(/const forUserId = seesTeam \? undefined : userId/);
    expect(loader.match(/forUserId \}\)/g)?.length).toBe(2);
    expect(loader).toMatch(/seesTeam && !includeInternals \? getBudgetForecast/);
    const page = read('usage/page.tsx');
    expect(page).toContain("scope={loaded.scope}");
    expect(page).toMatch(/loaded\.scope === 'team' \? loadHostedRunner/);
  });

  it('keeps the Operator page (dispatch, gates, experiments) behind the platform-operator check', () => {
    const op = read('operator/page.tsx');
    expect(op).toMatch(/if \(!isPlatformOperator\(user\)\) notFound\(\);/);
  });
});
