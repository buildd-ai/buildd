/**
 * Roles grid: a card per working role, hairline rows for idle and personal
 * roles. Idle state renders once; the settings frame owns the page title.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';

mock.module('next/link', () => ({
  default: ({ href, children, ...props }: any) => createElement('a', { href, ...props }, children),
}));

import { TeamGrid } from './TeamGrid';
import type { PersonalRoleEntry } from './page';

describe('TeamGrid', () => {
  it("names a working role's task by its display title, without the commit prefix", () => {
    const html = renderToStaticMarkup(
      <TeamGrid
        activeRoles={[{
          id: 'role-1', teamId: 'team-1', workspaceId: null, scopeLabel: 'All workspaces', overrideCount: 0, overrides: [],
          slug: 'builder', name: 'Builder', description: null, color: '#4F46E5', model: 'premium', allowedTools: [],
          canDelegateTo: [], enabled: true, isRole: true, stats: null, activeWorkerCount: 1,
          currentTask: { id: 't-1', title: 'refactor(missions): one settings sheet', workspaceName: 'Workspace 1', workerStatus: 'running', startedAt: new Date(0).toISOString() },
        }]}
        idleRoles={[]}
        workspaceIds={['ws-1']}
        teamId="team-1"
        totalActiveWorkerCount={1}
      />
    );
    expect(html).toContain('One settings sheet');
    expect(html).not.toContain('refactor(missions):');
  });

  describe('idle state on mobile', () => {
    it('does not duplicate "Idle" state when all roles are idle and zero workers running', () => {
      const html = renderToStaticMarkup(
        <TeamGrid
          activeRoles={[]}
          idleRoles={[
            {
              id: 'role-1',
              teamId: 'team-1',
              workspaceId: null,
              scopeLabel: 'All workspaces',
              overrideCount: 0,
              overrides: [],
              slug: 'builder',
              name: 'Builder',
              description: 'Builds features',
              color: '#4F46E5',
              model: 'claude-opus-5-5',
              allowedTools: [],
              canDelegateTo: [],
              enabled: true,
              isRole: true,
              stats: null,
              currentTask: null,
              activeWorkerCount: 0,
            },
          ]}
          workspaceIds={['ws-1']}
          teamId="team-1"
          totalActiveWorkerCount={0}
        />
      );

      // Should NOT show "No active tasks" — Idle is sufficient on its own
      expect(html).not.toContain('No active tasks');

      // Should NOT show the old duplicate text
      expect(html).not.toContain('Idle · No active tasks');

      // Should show "Idle" label in the section
      expect(html).toContain('Idle');
    });

    it('shows N running pill when workers are active', () => {
      const html = renderToStaticMarkup(
        <TeamGrid
          activeRoles={[]}
          idleRoles={[]}
          workspaceIds={['ws-1']}
          teamId="team-1"
          totalActiveWorkerCount={2}
        />
      );

      expect(html).toContain('2 running');
    });

    it('renders no page title of its own: SettingsPage owns "Roles"', () => {
      const html = renderToStaticMarkup(
        <TeamGrid activeRoles={[]} idleRoles={[]} workspaceIds={['ws-1']} teamId="team-1" totalActiveWorkerCount={0} />
      );
      expect(html).not.toContain('<h1');
      expect(html).not.toContain('The Team');
      expect(html).not.toContain('uppercase');
    });
  });

  describe('personal roles', () => {
    const mine = (overrides: Partial<PersonalRoleEntry> = {}): PersonalRoleEntry => ({
      id: 'p-1', slug: 'my-reviewer', name: 'My Reviewer', description: null, color: '#000000',
      model: 'inherit', visibility: 'private', isMine: true, ownerName: null, ...overrides,
    });
    const render = (props: Partial<Parameters<typeof TeamGrid>[0]>) => renderToStaticMarkup(
      <TeamGrid
        activeRoles={[]}
        idleRoles={[]}
        workspaceIds={['ws-1']}
        teamId="team-1"
        totalActiveWorkerCount={0}
        {...props}
      />,
    );

    it('lists the viewer\'s own roles under Mine with a private / shared badge', () => {
      const html = render({
        personalRoles: [mine(), mine({ id: 'p-2', slug: 'my-writer', name: 'My Writer', visibility: 'team' })],
        canCreatePersonalRole: true,
      });
      expect(html).toContain('data-testid="team-mine-section"');
      expect(html).toContain('My Reviewer');
      expect(html).toContain('Private');
      expect(html).toContain('Shared');
      // Personal slugs are not unique, so the link carries the id.
      expect(html).toContain('/app/settings/roles/my-reviewer/edit?id=p-1');
    });

    it('shows a teammate\'s shared role with its owner, outside Mine', () => {
      const html = render({
        personalRoles: [mine({ id: 'p-9', slug: 'their-role', name: 'Their Role', visibility: 'team', isMine: false, ownerName: 'Ada' })],
      });
      expect(html).toContain('data-testid="team-shared-section"');
      expect(html).toContain('by Ada');
      expect(html).not.toContain('data-testid="team-mine-section"');
    });

    it('a member who can only create personal roles gets New role pointed at "Just for me"', () => {
      const html = render({ canCreatePersonalRole: true, canCreateTeamRole: false });
      expect(html).toContain('href="/app/settings/roles/new?kind=personal"');
      expect(html).not.toContain('href="/app/settings/roles/new"');
    });

    it('no New role at all when the viewer holds neither permission', () => {
      const html = render({ canCreatePersonalRole: false, canCreateTeamRole: false });
      expect(html).not.toContain('New role');
      expect(html).not.toContain('Just for me');
    });

    it('an admin gets the plain New role link (the form offers both kinds)', () => {
      const html = render({ canCreatePersonalRole: true, canCreateTeamRole: true });
      expect(html).toContain('href="/app/settings/roles/new"');
    });
  });
});
