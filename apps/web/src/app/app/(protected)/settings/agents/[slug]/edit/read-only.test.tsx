/**
 * Editing a team role, its workspace overrides and its deploy access grants
 * is manage_agent_roles (the roles routes refuse anyone else). The settings page passes `canEdit`; without it the role
 * stays readable and nothing on it can be saved, deleted or added.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/settings/agents/builder/edit',
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
    expect(html).toContain('Admins can change this agent.');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain('You build.');
    expect(html).not.toContain('data-testid="header-save"');
    expect(html).not.toContain('data-testid="mobile-save-bar"');
    expect(html).not.toContain('Delete this agent');
    expect(html).not.toContain('+ Add override');
  });

  it('admin: save, delete and new override, nothing disabled', () => {
    const html = render(true);
    expect(html).not.toContain('role-read-only');
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('data-testid="header-save"');
    expect(html).toContain('Delete this agent');
    expect(html).toContain('+ Add override');
  });
});

describe('OperatorAccessSection (Deploy access): member vs admin', () => {
  const renderOp = (canEdit: boolean, overrides: unknown[] = []) =>
    renderToStaticMarkup(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <OperatorAccessSection roleId="role-op" teamMetadata={null} overrides={overrides as any} workspaces={workspaces} canEdit={canEdit} />,
    );

  it('never names the platform operator', () => {
    for (const html of [renderOp(true), renderOp(false)]) {
      expect(html).toContain('Deploy access');
      expect(html).not.toContain('Platform Operator');
      expect(html).not.toContain('Effective grant');
    }
  });

  it('member: one plain line, no editor', () => {
    const html = renderOp(false);
    expect(html).toContain('data-testid="deploy-access-summary"');
    expect(html).toContain('Can&#x27;t deploy from any workspace.');
    expect(html).not.toContain('<fieldset');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Team limit');
    expect(html).not.toContain('Save team limit');
  });

  it('member: names the workspaces the agent can deploy from', () => {
    const html = renderOp(false, [
      { id: 'o-1', workspaceId: 'ws-1', metadata: { operator: { enabled: true, capabilities: ['deployments:write'] } } },
    ]);
    expect(html).toContain('Can deploy from billing-web.');
    expect(html).not.toContain('docs.');
  });

  it('admin: the team limit and workspace grants save', () => {
    const html = renderOp(true);
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).toContain('Team limit');
    expect(html).toContain('Save team limit');
    expect(html).toContain('billing-web');
    expect(html).not.toContain('deploy-access-summary');
  });
});
