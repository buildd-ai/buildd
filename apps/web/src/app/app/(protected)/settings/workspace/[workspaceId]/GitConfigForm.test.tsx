import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GitConfigForm } from './GitConfigForm';

const render = (initialConfig: Record<string, unknown> | null, canEdit = true, part: 'repository' | 'agents' = 'repository') =>
  renderToStaticMarkup(
    <GitConfigForm part={part} workspaceId="ws-1" workspaceName="ws" initialConfig={initialConfig as never} canEdit={canEdit} />,
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
// is still read by the evaluator and set through the platform-owner API, so a save must not
// overwrite it.
describe('GitConfigForm goal grading', () => {
  it('has no grading control, editable or read-only', () => {
    for (const canEdit of [true, false]) {
      const html = render({ ...base, criteriaGrader: 'runner' }, canEdit) + render({ ...base, criteriaGrader: 'runner' }, canEdit, 'agents');
      expect(html).not.toMatch(/criteria grading|goal grading/i);
      expect(html).not.toContain('API key');
    }
  });

  it('does not send criteriaGrader when saving', async () => {
    const src = await Bun.file(new URL('./GitConfigForm.tsx', import.meta.url)).text();
    expect(src).not.toContain('criteriaGrader');
  });
});

// Settings spec R-5 / AC-5: "Runner type" was saved but nothing read it — task
// creation takes runnerPreference from the request only. The control is gone and
// a save leaves the stored value alone.
describe('GitConfigForm runner preference', () => {
  it('has no Runner type control, editable or read-only', () => {
    for (const canEdit of [true, false]) {
      const html = render({ ...base, defaultRunnerPreference: 'service' }, canEdit) + render({ ...base, defaultRunnerPreference: 'service' }, canEdit, 'agents');
      expect(html).not.toContain('Runner type');
      expect(html).not.toContain('Service runners only');
    }
  });

  it('does not send defaultRunnerPreference when saving', async () => {
    const src = await Bun.file(new URL('./GitConfigForm.tsx', import.meta.url)).text();
    expect(src).not.toContain('defaultRunnerPreference');
  });
});

// Settings spec R-2 / R-3 / R-4: Repository holds the git workflow, Agents holds
// how agents run with debug logging under a closed Advanced, and each part's
// Save works only once that part has changes.
describe('GitConfigForm parts', () => {
  it('Repository: the git workflow, nothing about agents', () => {
    const html = render(base);
    expect(html).toContain('Git workflow');
    expect(html).not.toContain('Branching strategy');
    expect(html).toContain('Commit style');
    expect(html).not.toMatch(/Additional instructions|Sandbox|Fallback model|Effort level|debug/i);
  });

  it('Agents: instructions, sandbox and model, with debug logging under a closed Advanced', () => {
    const html = render(base, true, 'agents');
    expect(html).not.toMatch(/Git workflow|Commit style|Default branch/);
    for (const label of ['Additional instructions', 'Enable sandbox isolation', 'Agent backend', 'Fallback model', 'Thinking mode', 'Effort level']) {
      expect(html).toContain(label);
    }
    const advanced = html.slice(html.indexOf('data-testid="git-config-advanced"'));
    expect(html).toMatch(/<details[^>]*data-testid="git-config-advanced"/);
    expect(html).not.toMatch(/<details[^>]*\bopen\b[^>]*data-testid="git-config-advanced"/);
    expect(advanced).toContain('Write debug logs');
    expect(html.indexOf('Write debug logs')).toBeGreaterThan(html.indexOf('data-testid="git-config-advanced"'));
  });

  it('starts with Save disabled: nothing has changed yet', () => {
    for (const part of ['repository', 'agents'] as const) {
      expect(render(base, true, part)).toMatch(/<button type="submit" disabled="" class="btn min-h-11">Save<\/button>/);
    }
  });
});
