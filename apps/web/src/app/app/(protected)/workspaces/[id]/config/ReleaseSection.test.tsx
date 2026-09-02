import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ReleaseSection from './ReleaseSection';
import type { WorkspaceReleaseConfig } from '@buildd/core/db/schema';

const enabledConfig: WorkspaceReleaseConfig = {
  enabled: true,
  strategy: 'workflow_dispatch',
  workflowFile: 'release.yml',
  ref: 'dev',
  trigger: 'manual',
};

describe('ReleaseSection — AC-47 (no Release now trigger on workspace config)', () => {
  it('does not render a Release now button when a release strategy is configured', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} />,
    );
    // "Release now" only appears (if at all) as a quoted reference inside help copy,
    // never as the text of a rendered <button> (which would read exactly `>Release now<`).
    expect(html).not.toContain('>Release now<');
    expect(html).not.toContain('Triggering…');
  });

  it('does not render a Release now button when no strategy is configured', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={null} hasRepo={true} />,
    );
    expect(html).not.toContain('>Release now<');
  });

  it('keeps the strategy selector, branch/workflow fields, trigger-policy selector, and read-only token status', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} />,
    );
    expect(html).toContain('Strategy');
    expect(html).toContain('Workflow file');
    expect(html).toContain('Trigger');
    expect(html).toContain('When mission completes');
    expect(html).toContain('Vercel token');
    expect(html).toContain('checking…');
  });

  it('points manual-trigger help text at mission detail / Home / MCP instead of the removed button', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} />,
    );
    expect(html).toContain('mission detail or Home');
    expect(html).toContain('trigger_release via MCP');
  });
});
