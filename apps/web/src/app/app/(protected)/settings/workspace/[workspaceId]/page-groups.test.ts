/**
 * One settings page per workspace: the old /app/workspaces/[id]/config page
 * merged into this one. page.tsx is a server component that needs a database,
 * so this pins the grouping at the source: the groups in order, each section
 * under its group, the frame, and what moved out.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

const GROUPS: Array<[string, string[]]> = [
  ['Readiness', ['<WorkspaceHealthCard', '<ReadinessCard', '<RepoAccessCard']],
  ['Repository', ['<GitConfigForm', '<MemberRepoAccessSection']],
  ['Delivery', ['<MergePolicyEditor', '<BranchStrategySection', '<CiRetrySection', '<ReleaseSection', '<SubjectPolicySection']],
  ['Where work runs', ['<ExecutorSection', '<RunnerSizeSection', '<ConcurrencySection']],
  ['Integrations', ['<WorkTrackerSection']],
  ['Danger zone', ['<MoveToTeamButton', '<DeleteWorkspaceButton']],
];

describe('workspace settings page', () => {
  it('renders the groups in order, each holding its sections', () => {
    const starts = GROUPS.map(([title]) => PAGE.indexOf(`title="${title}"`));
    for (const [i, [title]] of GROUPS.entries()) {
      expect(`${title}: ${starts[i] > -1}`).toBe(`${title}: true`);
      if (i > 0) expect(starts[i]).toBeGreaterThan(starts[i - 1]);
    }
    for (const [i, [title, parts]] of GROUPS.entries()) {
      const end = starts[i + 1] ?? PAGE.length;
      for (const part of parts) {
        const at = PAGE.indexOf(part, starts[i]);
        expect(`${title} ${part}: ${at > -1 && at < end}`).toBe(`${title} ${part}: true`);
      }
    }
  });

  it('uses the settings frame, not its own page shell', () => {
    expect(PAGE).toContain('<SettingsPage');
    expect(PAGE).not.toContain('<main');
    expect(PAGE).not.toContain('min-h-screen');
    expect(PAGE).not.toContain('headerAction');
  });

  it('points runner setup at Settings › Runners instead of repeating it', () => {
    expect(PAGE).not.toContain('ConnectClaudeSection');
    expect(existsSync(join(import.meta.dir, 'ConnectClaudeSection.tsx'))).toBe(false);
    expect(PAGE).toContain('href="/app/settings/runners"');
  });

  it('shows knowledge health on the workspace Memory page, not here', () => {
    expect(PAGE).not.toContain('KnowledgeHealthSection');
    const memory = readFileSync(join(import.meta.dir, '../../../workspaces/[id]/memory/page.tsx'), 'utf8');
    expect(memory).toContain('<KnowledgeHealthSection');
  });

  it('keeps the readiness rows admin-only, as the config page had them', () => {
    const readiness = PAGE.slice(PAGE.indexOf('title="Readiness"'), PAGE.indexOf('title="Repository"'));
    expect(readiness).toContain('{canManageSettings && (\n              <WorkspaceHealthCard');
    expect(readiness).toContain('{canManageSettings && <ReadinessCard');
    expect(PAGE).toContain("roleHas(access.role, 'manage_workspace_settings', overrides)");
  });
});
