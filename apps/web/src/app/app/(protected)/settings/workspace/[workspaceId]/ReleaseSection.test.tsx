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
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} canEdit />,
    );
    // "Release now" only appears (if at all) as a quoted reference inside help copy,
    // never as the text of a rendered <button> (which would read exactly `>Release now<`).
    expect(html).not.toContain('>Release now<');
    expect(html).not.toContain('Triggering…');
  });

  it('does not render a Release now button when no strategy is configured', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={null} hasRepo={true} canEdit />,
    );
    expect(html).not.toContain('>Release now<');
  });

  it('keeps the strategy selector, branch/workflow fields, trigger-policy selector, and read-only token status', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} canEdit />,
    );
    expect(html).toContain('Strategy');
    expect(html).toContain('Workflow file');
    expect(html).toContain('Trigger');
    expect(html).toContain('When mission completes');
    expect(html).toContain('Vercel token');
    expect(html).toContain('checking…');
  });

  it('points manual-trigger help text at Home / MCP instead of the removed button', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} canEdit />,
    );
    // Mission detail no longer carries the trigger (a release ships the workspace, not a mission).
    expect(html).toContain('on Home');
    expect(html).not.toContain('mission detail');
    expect(html).toContain('trigger_release over MCP');
  });

  it('shows the release candidate policy, unchecked and empty when none is configured', () => {
    const html = renderToStaticMarkup(
      <ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={enabledConfig} hasRepo={true} canEdit />,
    );
    expect(html).toContain('Release candidates');
    expect(html).not.toContain('Candidate branches');
    expect(html).toContain('Released once production runs the merge.');
    expect(html).not.toMatch(/shipped/i);
  });

  it('shows the configured candidate fields, and the policy as text for a read-only viewer', () => {
    const cfg: WorkspaceReleaseConfig = {
      ...enabledConfig, prodBranch: 'main',
      candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
    };
    const edit = renderToStaticMarkup(<ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={cfg} hasRepo={true} canEdit />);
    expect(edit).toContain('Candidate branches');
    expect(edit).toContain('value="release/v*"');
    expect(edit).toContain('value="github-actions[bot]"');
    const read = renderToStaticMarkup(<ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={cfg} hasRepo={true} canEdit={false} />);
    expect(read).toContain('release/v*');
    expect(read).toContain('Cut from dev, opened by github-actions[bot]');
  });

  it('shows the declared amend mapping, and "re-cut" when none is declared', () => {
    const policy = { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] };
    const mapped: WorkspaceReleaseConfig = { ...enabledConfig, prodBranch: 'main', candidate: { ...policy, amend: { mode: 'inputs', versionInput: 'amend', confirmInput: 'amend_confirm' } } };
    const edit = renderToStaticMarkup(<ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={mapped} hasRepo={true} canEdit />);
    expect(edit).toContain('When a fix merges');
    expect(edit).toContain('value="amend"');
    expect(edit).toContain('value="amend_confirm"');
    const read = renderToStaticMarkup(<ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={mapped} hasRepo={true} canEdit={false} />);
    expect(read).toContain('runs the workflow with amend and amend_confirm');
    const none = renderToStaticMarkup(<ReleaseSection workspaceId="ws-1" teamId="team-1" initialReleaseConfig={{ ...mapped, candidate: policy }} hasRepo={true} canEdit={false} />);
    expect(none).toContain('tells you to re-cut it');
  });
});
