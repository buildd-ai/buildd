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
  ['Repository', ['<GitConfigForm\n            part="repository"', '<MemberRepoAccessSection']],
  ['Agents', ['<GitConfigForm\n          part="agents"']],
  ['Delivery', ['<MergePolicyEditor', '<BranchStrategySection', '<CiRetrySection', '<ReleaseSection', '<SubjectPolicySection']],
  ['Where work runs', ['<ExecutorSection', '<RunnerSizeSection', '<FreshContainerSection', '<ConcurrencySection', '<PauseStartsSection']],
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

  // Settings spec R-1 / AC-1: an index links to every section the page renders.
  it('indexes every section, each link pointing at a rendered id', () => {
    expect(PAGE).toContain('<SectionIndex sections={sections} />');
    const indexed = [...PAGE.matchAll(/\{ id: '([a-z-]+)', label: '([^']+)' \}/g)].map((m) => [m[1], m[2]]);
    const rendered = [...PAGE.matchAll(/<(?:Section|SettingsSection|div) title="([^"]+)" id="([a-z-]+)"|<div id="([a-z-]+)"/g)]
      .map((m) => m[2] ?? m[3]);
    expect(indexed.map(([id]) => id).sort()).toEqual([...new Set(rendered)].sort());
    // The index comes before the first section.
    expect(PAGE.indexOf('<SectionIndex')).toBeLessThan(PAGE.indexOf('title="Readiness"'));
  });

  // Settings spec R-3 / AC-2: the two branching controls have distinct names.
  it('names Repository\'s control Git workflow and Delivery\'s Mission pull requests', () => {
    const form = readFileSync(join(import.meta.dir, 'GitConfigForm.tsx'), 'utf8');
    const strategy = readFileSync(join(import.meta.dir, 'BranchStrategySection.tsx'), 'utf8');
    expect(form).toContain('Git workflow');
    expect(form).not.toContain('Branching strategy');
    expect(strategy).toContain('Mission pull requests');
    expect(strategy).not.toContain('Branch strategy');
  });

  // Settings spec R-7 / AC-8: the clean-copy switch is about the cloud runner, so it
  // sits after cloud runner size and is not rendered for a host-only workspace.
  it('places the clean-copy switch after cloud runner size, only off host', () => {
    expect(PAGE.split('<FreshContainerSection').length - 1).toBe(1);
    expect(PAGE.indexOf('<FreshContainerSection')).toBeGreaterThan(PAGE.indexOf('<RunnerSizeSection'));
    expect(PAGE.indexOf('<FreshContainerSection')).toBeLessThan(PAGE.indexOf('<ConcurrencySection'));
    expect(PAGE).toMatch(/executor\.executor !== 'host' && \(?\s*<FreshContainerSection/);
  });

  it('holds the workspace\'s own model keys, between Where work runs and Integrations', () => {
    const at = PAGE.indexOf('<WorkspaceModels');
    expect(at).toBeGreaterThan(PAGE.indexOf('title="Where work runs"'));
    expect(at).toBeLessThan(PAGE.indexOf('title="Integrations"'));
  });

  it('offers Move to team once, under Danger zone, not again in the health card', () => {
    expect(PAGE.split('<MoveToTeamButton').length - 1).toBe(1);
    expect(PAGE).not.toContain('userTeamCount');
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
    // Settings spec R-11: the link opens Runners on this workspace's team.
    expect(PAGE).toContain('href={`/app/settings/runners?team=${encodeURIComponent(workspace.teamId)}`}');
  });

  it('shows knowledge health on the workspace Memory page, not here', () => {
    expect(PAGE).not.toContain('KnowledgeHealthSection');
    const memory = readFileSync(join(import.meta.dir, '../../../workspaces/[id]/memory/page.tsx'), 'utf8');
    expect(memory).toContain('<KnowledgeHealthSection');
  });

  it('keeps the readiness rows admin-only, as the config page had them', () => {
    const readiness = PAGE.slice(PAGE.indexOf('title="Readiness"'), PAGE.indexOf('title="Repository"'));
    // Visibility (admin-only, one notice per problem) lives in readiness-notices.ts.
    expect(readiness).toContain('{notices.health.length > 0 && (\n              <WorkspaceHealthCard');
    expect(readiness).toContain('{notices.readiness && <ReadinessCard');
    expect(readiness).toContain('{notices.repoAccess && repoAccessView && (');
    expect(PAGE).toContain('canManage: canManageSettings,');
    expect(PAGE).toContain("roleHas(access.role, 'manage_workspace_settings')");
  });

  it('names the workspace on a phone, where the shell header only says Workspaces', () => {
    expect(PAGE).toMatch(/<SettingsPage\s+title=\{workspace\.name\}\s+titleOnMobile/);
  });
});

// Settings spec R-11 / AC-12: Runners shows the team it is for, `?team=` picks it,
// and Members and Runners share the one switcher.
describe('settings runners page', () => {
  const RUNNERS = readFileSync(join(import.meta.dir, '../../runners/page.tsx'), 'utf8');
  const MEMBERS = readFileSync(join(import.meta.dir, '../../team/page.tsx'), 'utf8');
  it('picks the team from ?team= and shows the switcher', () => {
    expect(RUNNERS).toContain('pickShownTeam(teams, teamParam, currentTeam)');
    expect(RUNNERS).toContain('<TeamSwitcher');
    expect(RUNNERS).toContain('basePath="/app/settings/runners"');
    expect(MEMBERS).toContain('<TeamSwitcher');
  });
});
