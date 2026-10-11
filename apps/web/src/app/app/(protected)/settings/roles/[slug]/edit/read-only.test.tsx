/**
 * Editing a team role, its workspace overrides and the Platform Operator grants
 * is manage_agent_roles (the roles routes refuse anyone else, with the team's
 * overrides applied). The settings page passes `canEdit`; without it the role
 * stays readable and nothing on it can be saved, deleted or added.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/settings/roles/builder/edit',
  useSearchParams: () => new URLSearchParams(''),
}));

const { TeamRoleEditor } = await import('./TeamRoleEditor');
const { OperatorAccessSection } = await import('./OperatorAccessSection');

// Illustrative fixtures only.
const role = {
  id: 'role-1', teamId: 'team-1', workspaceId: null, slug: 'builder', name: 'Builder',
  description: null, content: 'You build.', model: 'inherit', defaultBackend: null,
  allowedTools: ['Read', 'Bash'], canDelegateTo: [], background: false, maxTurns: null, color: '#0C72CB',
  mcpServers: [], requiredEnvVars: {}, isRole: true, repoUrl: null, metadata: null,
};
const workspaces = [{ id: 'ws-1', name: 'billing-web' }, { id: 'ws-2', name: 'docs' }];

const render = (canEdit: boolean) =>
  renderToStaticMarkup(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <TeamRoleEditor role={role as any} overrides={[]} workspaces={workspaces} delegateOptions={[]} canEdit={canEdit} />,
  );

describe('TeamRoleEditor: member vs admin', () => {
  it('member: the role in a disabled fieldset, no save, delete or new override', () => {
    const html = render(false);
    expect(html).toContain('data-testid="role-read-only"');
    expect(html).toContain('Admins can change this role.');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain('You build.');
    expect(html).not.toContain('data-testid="header-save"');
    expect(html).not.toContain('data-testid="mobile-save-bar"');
    expect(html).not.toContain('Delete this role');
    expect(html).not.toContain('+ Add override');
  });

  it('admin: save, delete and new override, nothing disabled', () => {
    const html = render(true);
    expect(html).not.toContain('role-read-only');
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('data-testid="header-save"');
    expect(html).toContain('Delete this role');
    expect(html).toContain('+ Add override');
  });
});

describe('OperatorAccessSection: member vs admin', () => {
  const renderOp = (canEdit: boolean) =>
    renderToStaticMarkup(
      <OperatorAccessSection roleId="role-op" teamMetadata={null} overrides={[]} workspaces={workspaces} canEdit={canEdit} />,
    );

  it('member: the team ceiling is a disabled fieldset with no save', () => {
    const html = renderOp(false);
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).not.toContain('Save team ceiling');
    // Each workspace row still lists, so the grants in effect are visible.
    expect(html).toContain('billing-web');
  });

  it('admin: the ceiling saves', () => {
    const html = renderOp(true);
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('Save team ceiling');
  });
});
