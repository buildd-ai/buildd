/**
 * Team page grid: active role cards, idle role chips.
 * Mobile: idle state renders once, proper spacing from banner.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/link', () => ({
  default: ({ href, children, ...props }: any) => `<a href="${href}" ${Object.entries(props).map(([k, v]) => `${k}="${v}"`).join(' ')}>${children}</a>`,
}));

import { TeamGrid } from './TeamGrid';

describe('TeamGrid', () => {
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

    it('header has proper top margin for spacing from banner', () => {
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
              description: null,
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

      // Header wrapper should have mb-6 for bottom spacing
      expect(html).toContain('mb-6');
      // And mt-0 for top spacing (explicitly set to ensure banner has proper gap)
      expect(html).toContain('mt-0');
    });
  });
});
