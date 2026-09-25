import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkWorkspaceHealth, type WorkspaceHealthInput } from '@/lib/workspace-health';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { WorkspaceHealthCard } = await import('./WorkspaceHealthCard');

const workspace = { id: 'ws-1', name: 'app', teamId: 'team-a' };
const teams = [{ id: 'team-a', name: 'Team A' }, { id: 'team-b', name: 'Team B' }];

const legacy: WorkspaceHealthInput = {
  name: 'app',
  repo: 'https://github.com/example/app',
  configStatus: 'unconfigured',
  accessMode: 'open',
  gitConfig: null,
  userTeamCount: 2,
};

const render = (input: WorkspaceHealthInput) =>
  renderToStaticMarkup(
    <WorkspaceHealthCard workspace={workspace} teams={teams} items={checkWorkspaceHealth(input)} />,
  );

describe('WorkspaceHealthCard', () => {
  it('renders nothing when there is nothing to show', () => {
    expect(render({ ...legacy, configStatus: 'admin_confirmed', accessMode: 'restricted', userTeamCount: 1 })).toBe('');
  });

  it('renders one button per line, labelled with the action', () => {
    const html = render(legacy);
    expect(html).toContain('Workspace health');
    expect(html).toContain('>Review proposed policy<');
    expect(html).toContain('>Move to team…<');
    expect(html.match(/<button/g)).toHaveLength(2);
    // open access is open within the owning team — never offered as a fix
    expect(html).not.toContain('Restrict to team members');
  });

  it('shows the system-workspace info line without a button', () => {
    const html = render({ ...legacy, name: '__coordination', repo: null });
    expect(html).toContain('System workspace for orchestration — no repo by design');
    expect(html).not.toContain('<button');
  });

  it('keeps every action button at least 44px tall', () => {
    const buttons = render(legacy).match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) expect(b).toContain('min-h-11');
  });
});
