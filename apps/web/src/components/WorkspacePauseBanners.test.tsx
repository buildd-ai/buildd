import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { renderToStaticMarkup } from 'react-dom/server';
import WorkspacePauseBanners from './WorkspacePauseBanners';

/**
 * Health › Runners shows a pause and links to where it is changed; the control
 * itself is on the workspace's settings page (PauseStartsSection).
 */
describe('WorkspacePauseBanners', () => {
  const until = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  it('one read-only banner per paused workspace, linking to its settings', () => {
    const html = renderToStaticMarkup(
      <WorkspacePauseBanners workspaces={[{ id: 'ws-a', name: 'web', pausedUntil: until }, { id: 'ws-b', name: 'docs', pausedUntil: null }]} />,
    );
    expect(html.split('data-testid="workspace-pause-banner"').length - 1).toBe(1);
    expect(html).toContain('New starts paused in web');
    expect(html).toContain('href="/app/settings/workspace/ws-a#pause-starts"');
    expect(html).not.toContain('<button');
  });

  it('renders nothing when nothing is paused', () => {
    expect(renderToStaticMarkup(<WorkspacePauseBanners workspaces={[]} />)).toBe('');
  });

  it('is what Health › Runners mounts: no pause control there', () => {
    const page = readFileSync(resolve(import.meta.dir, '../app/app/(protected)/health/runners/page.tsx'), 'utf8');
    expect(page).toContain('<WorkspacePauseBanners');
    expect(page).not.toContain('WorkspacePausePanel');
  });
});
