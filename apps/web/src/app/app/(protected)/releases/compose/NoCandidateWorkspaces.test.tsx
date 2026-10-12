import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import NoCandidateWorkspaces, { releaseSettingsHref } from './NoCandidateWorkspaces';

describe('NoCandidateWorkspaces', () => {
  it('has a page title', () => {
    const html = renderToStaticMarkup(<NoCandidateWorkspaces workspaces={[]} />);
    expect(html).toMatch(/<h1[^>]*>Compose a release<\/h1>/);
  });

  it('links each workspace to its release settings', () => {
    const html = renderToStaticMarkup(
      <NoCandidateWorkspaces workspaces={[{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }]} />,
    );
    expect(html).toContain(`href="${releaseSettingsHref('ws-a')}"`);
    expect(html).toContain(`href="${releaseSettingsHref('ws-b')}"`);
    expect(html).toContain('Alpha');
    expect(html).toContain('Beta');
  });

  it('points at the Delivery section, where release settings live', () => {
    expect(releaseSettingsHref('ws-a')).toBe('/app/settings/workspace/ws-a#delivery');
  });

  it('with no workspaces, links to the workspace list instead of a dead end', () => {
    const html = renderToStaticMarkup(<NoCandidateWorkspaces workspaces={[]} />);
    expect(html).toContain('href="/app/settings/workspaces"');
  });
});
