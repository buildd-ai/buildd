import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitConfigForm } from './GitConfigForm';

const render = (initialConfig: Record<string, unknown> | null, canEdit = true) =>
  renderToStaticMarkup(
    <GitConfigForm workspaceId="ws-1" workspaceName="ws" initialConfig={initialConfig as never} canEdit={canEdit} />,
  );

const base = { defaultBranch: 'main', branchingStrategy: 'feature', commitStyle: 'freeform', requiresPR: true, autoCreatePR: true, useClaudeMd: true };

// The old "Auto-merge on green CI" checkbox wrote `autoMergeOnGreenCI`, which no
// merge gate reads — the merge policy decides. The form must not offer a control
// that does nothing; it shows the real policy and links to where it is edited.
describe('GitConfigForm merge behaviour', () => {
  it('has no auto-merge checkbox', () => {
    const html = render({ ...base, autoMergeOnGreenCI: false });
    expect(html).not.toContain('id="autoMergeOnGreenCI"');
    expect(html).not.toContain('Auto-merge on green CI');
  });

  it('shows the default policy when none is set, and links to the merge policy editor', () => {
    const html = render(base);
    expect(html).toContain('data-testid="git-config-merge-policy"');
    expect(html).toContain('/app/settings/workspace/ws-1');
    expect(html).toMatch(/auto-merge on green CI/i);
    expect(html).toContain('(default)');
  });

  it('shows a human policy as such, whatever the legacy flag says', () => {
    const html = render({ ...base, autoMergeOnGreenCI: true, mergePolicy: { tier: 'human' } });
    expect(html).toMatch(/a person merges every PR/i);
    expect(html).not.toContain('(default)');
  });

  it('shows an agent-review policy', () => {
    const html = render({ ...base, mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } });
    expect(html).toMatch(/reviewer agent/i);
  });
});

describe('GitConfigForm without settings permission', () => {
  it('shows every setting as text, with no fields and no Save', () => {
    const html = render({ ...base, defaultBranch: 'dev', commitStyle: 'conventional' }, false);
    expect(html).toContain('data-testid="git-config-read-only"');
    expect(html).not.toMatch(/<input|<select|<textarea|<button|role="radio"|role="combobox"/);
    expect(html).toContain('Conventional Commits');
    expect(html).toMatch(/>dev</);
    // The merging line still links to the merge policy.
    expect(html).toContain('data-testid="git-config-merge-policy"');
  });
});

// Goal grading is Auto everywhere. The control is gone; gitConfig.criteriaGrader
// is still read by the evaluator and set from the admin app, so a save must not
// overwrite it.
describe('GitConfigForm goal grading', () => {
  it('has no grading control, editable or read-only', () => {
    for (const canEdit of [true, false]) {
      const html = render({ ...base, criteriaGrader: 'runner' }, canEdit);
      expect(html).not.toMatch(/criteria grading|goal grading/i);
      expect(html).not.toContain('API key');
    }
  });

  it('does not send criteriaGrader when saving', async () => {
    const src = await Bun.file(new URL('./GitConfigForm.tsx', import.meta.url)).text();
    expect(src).not.toContain('criteriaGrader');
  });
});
