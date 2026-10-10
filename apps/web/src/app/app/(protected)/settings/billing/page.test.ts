import { describe, expect, it } from 'bun:test';

/**
 * Billing and budgets is where a team admin reads what the team spends: their own spend,
 * everyone's, and the hosted runner month. Health › Usage moved to the admin
 * app, so nothing here sends anyone there.
 */
const page = await Bun.file(new URL('./page.tsx', import.meta.url)).text();

describe('Settings → Billing and budgets', () => {
  it('does not link to Health › Usage', () => {
    expect(page).not.toContain('/app/health/usage');
    expect(page).not.toContain('budgets-usage-link');
  });

  it("shows the team's hosted runner month to people who see team spend", () => {
    expect(page).toContain('<HostedRunnerUsageSection');
    expect(page).toMatch(/perms\.view_team_usage \? loadHostedRunnerMonth\(/);
  });
});
