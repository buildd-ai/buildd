import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MergePolicy, WorkspacePolicyConfig } from '@buildd/shared';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

const { default: MergePolicyEditor } = await import('./MergePolicyEditor');

const policyConfig: WorkspacePolicyConfig = {
  preset: 'balanced',
  riskClasses: [
    { name: 'ci_deploy_config', detectedPaths: ['.github/workflows/'] },
    { name: 'dependency_bump', detectedPaths: [] },
  ],
};

const render = (initial: MergePolicy, pc: WorkspacePolicyConfig | null = policyConfig) =>
  renderToStaticMarkup(
    <MergePolicyEditor
      workspaceId="ws-1"
      workspaceName="app"
      initial={initial}
      policyConfig={pc}
      roles={[{ slug: 'reviewer', name: 'Reviewer' }]}
      missionOverrides={[]}
    />,
  );

describe('MergePolicyEditor — paths are detected, not typed', () => {
  for (const tier of ['auto-threshold', 'agent-review', 'human'] as const) {
    it(`has no path inputs and one Re-scan repo button (${tier})`, () => {
      const html = render({ tier, agentReview: tier === 'agent-review' ? { reviewerRole: 'reviewer' } : undefined });
      expect(html).not.toMatch(/Deny paths|Escalate to human for paths|e\.g\. drizzle\/|e\.g\. packages\/core\/db\//);
      expect(html.match(/data-testid="merge-policy-rescan"/g)).toHaveLength(1);
      expect(html).toContain('>Re-scan repo<');
    });
  }

  it('lists the applied detected paths read-only', () => {
    const html = render({ tier: 'auto-threshold' });
    expect(html).toContain('CI and deploy config');
    expect(html).toContain('.github/workflows/');
    // a class with no detected paths is not listed
    expect(html).not.toContain('Dependency bumps');
  });

  it('prompts a first scan when no policy is applied', () => {
    expect(render({ tier: 'auto-threshold' }, null)).toContain('No risk-class policy');
  });
});

describe('MergePolicyEditor — paths flagged in review', () => {
  const suggestions = [
    { path: 'apps/api/package.json', class: 'dependency_bump' as const },
    { path: 'lib/auth/session.ts', class: 'auth_and_secrets' as const },
  ];
  const renderWith = (canEdit: boolean) =>
    renderToStaticMarkup(
      <MergePolicyEditor
        workspaceId="ws-1"
        workspaceName="app"
        initial={{ tier: 'auto-threshold' }}
        policyConfig={policyConfig}
        policySuggestions={suggestions}
        roles={[]}
        missionOverrides={[]}
        canEdit={canEdit}
      />,
    );

  it('lists each suggested path with its class and an add action', () => {
    const html = renderWith(true);
    expect(html).toContain('data-testid="merge-policy-suggestions"');
    expect(html).toContain('apps/api/package.json');
    expect(html).toContain('Auth and secrets');
    expect(html.match(/data-testid="merge-policy-suggestion-add"/g)).toHaveLength(2);
    expect(html).toContain('Add all');
  });

  it('is read-only without settings permission', () => {
    const html = renderWith(false);
    expect(html).toContain('apps/api/package.json');
    expect(html).not.toContain('merge-policy-suggestion-add');
    expect(html).not.toContain('Add all');
  });

  it('renders nothing when no review flagged a path', () => {
    expect(render({ tier: 'auto-threshold' })).not.toContain('merge-policy-suggestions');
  });
});

/**
 * Writing the merge policy is manage_workspace_settings (the workspace PATCH
 * refuses anyone else). Without it the policy in effect stays readable and
 * nothing in it can be changed.
 */
describe('MergePolicyEditor — editable only with manage_workspace_settings', () => {
  const renderAs = (canEdit: boolean) =>
    renderToStaticMarkup(
      <MergePolicyEditor
        workspaceId="ws-1"
        workspaceName="app"
        initial={{ tier: 'auto-threshold', threshold: { maxLines: 500 } }}
        policyConfig={policyConfig}
        roles={[]}
        missionOverrides={[]}
        canEdit={canEdit}
      />,
    );

  it('member: the current tier and limit, inside a disabled fieldset, with no Save', () => {
    const html = renderAs(false);
    expect(html).toContain('data-testid="merge-policy-read-only"');
    expect(html).toContain('Admins can change this.');
    expect(html).toMatch(/<fieldset[^>]*disabled=""/);
    expect(html).toContain('value="500"');
    expect(html).not.toContain('>Save<');
  });

  it('admin: Save, and no disabled fieldset', () => {
    const html = renderAs(true);
    expect(html).toContain('>Save<');
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain('merge-policy-read-only');
  });
});

describe('MergePolicyEditor — data migrations', () => {
  it('agent-review: shows who decides data migrations, a person by default', () => {
    const html = render({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } });
    expect(html).toContain('Data migrations');
    expect(html).toContain('A person decides');
  });

  it('agent-review with the setting on shows the reviewer agent decides', () => {
    const html = render({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' }, dataMigrations: 'agent-review' });
    expect(html).toContain('Reviewer agent decides');
  });

  it('other tiers have no data-migration control (there is no reviewer to decide)', () => {
    expect(render({ tier: 'auto-threshold', threshold: { maxLines: 800 } })).not.toContain('Data migrations');
    expect(render({ tier: 'human' })).not.toContain('Data migrations');
  });
});
