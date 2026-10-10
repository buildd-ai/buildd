import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { checkWorkspaceHealth, type WorkspaceHealthInput } from '@/lib/workspace-health';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { WorkspaceHealthCard } = await import('./WorkspaceHealthCard');

const workspace = { id: 'ws-1', name: 'app' };

const legacy: WorkspaceHealthInput = {
  name: 'app',
  repo: 'https://github.com/example/app',
  configStatus: 'unconfigured',
  accessMode: 'open',
  gitConfig: null,
};

const render = (input: WorkspaceHealthInput) =>
  renderToStaticMarkup(
    <WorkspaceHealthCard workspace={workspace} items={checkWorkspaceHealth(input)} />,
  );

describe('WorkspaceHealthCard', () => {
  it('renders nothing when there is nothing to show', () => {
    expect(render({ ...legacy, configStatus: 'admin_confirmed', accessMode: 'restricted' })).toBe('');
  });

  it('renders one button per line, labelled with the action', () => {
    const html = render(legacy);
    expect(html).toContain('Workspace health');
    expect(html).toContain('>Review proposed policy<');
    // Move to team lives under Danger zone only
    expect(html).not.toContain('Move to team');
    expect(html.match(/<button/g)).toHaveLength(1);
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
    expect(buttons).toHaveLength(1);
    for (const b of buttons) expect(b).toContain('min-h-11');
  });
});
