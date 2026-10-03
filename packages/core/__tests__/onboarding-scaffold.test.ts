import { describe, test, expect } from 'bun:test';
import type { ReadinessInput } from '../workspace-readiness';
import { planScaffold, SCAFFOLD_ITEM_IDS, buildScaffoldTaskDescription } from '../onboarding-scaffold';

// A Python/uv service with none of buildd's layout, names or toolchain.
const PYPROJECT = `[project]
name = "acme-ledger"

[tool.pytest.ini_options]
testpaths = ["tests"]

[tool.mypy]
strict = true
`;

function repo(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    files: ['pyproject.toml', 'uv.lock', 'src/acme/__init__.py', 'tests/test_ledger.py', '.github/workflows/ci.yml'],
    truncated: false,
    manifests: { 'pyproject.toml': PYPROJECT },
    deployments: [],
    branches: ['trunk'],
    gitConfig: {},
    configStatus: 'unconfigured',
    ...over,
  };
}

const base = { projectName: 'acme-ledger', defaultBranch: 'trunk' };

describe('planScaffold', () => {
  test('no item ids is a no-op', () => {
    const plan = planScaffold({ ...base, itemIds: [], readiness: repo() });
    expect(plan.files).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.prs).toEqual([]);
  });

  test('renders only what was named, with the detected commands', () => {
    const plan = planScaffold({ ...base, itemIds: ['agent-instructions'], readiness: repo() });
    expect(plan.files.map((f) => f.path)).toEqual(['CLAUDE.md']);
    const md = plan.files[0].content;
    expect(md).toContain('`uv run pytest`');
    expect(md).toContain('`uv run mypy .`');
    expect(md).toContain('`trunk`');
    expect(plan.files[0].group).toBe('docs');
    expect(plan.files[0].commitMessage).toBe('docs: add agent instructions');
  });

  test('an undetectable command renders a TODO(owner), not a guess', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions'],
      readiness: repo({ files: ['README.md', 'notes.txt'], manifests: {} }),
    });
    expect(plan.files[0].content).toContain('TODO(owner)');
    expect(plan.files[0].content).not.toContain('uv run');
  });

  test('spec-root and spec-format land one format document, and the instructions name that root', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions', 'spec-root', 'spec-format'],
      readiness: repo(),
    });
    expect(plan.files.map((f) => f.path)).toEqual(['CLAUDE.md', 'docs/specs/SPEC-FORMAT.md']);
    expect(plan.files[0].content).toContain('docs/specs/SPEC-FORMAT.md');
    expect(plan.files[1].itemIds).toEqual(['spec-root', 'spec-format']);
    expect(plan.prs).toHaveLength(1);
    expect(plan.prs[0].group).toBe('docs');
  });

  test('one commit per item, in a stable order', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['env-manifest', 'spec-root', 'agent-instructions'],
      readiness: repo(),
    });
    expect(plan.files.map((f) => f.commitMessage)).toEqual([
      'docs: add agent instructions',
      'docs: add spec format',
      'chore: add env manifest',
    ]);
  });

  test('env-manifest is generated from the detected toolchain', () => {
    const plan = planScaffold({ ...base, itemIds: ['env-manifest'], readiness: repo() });
    expect(plan.files[0].path).toBe('.buildd/env.yaml');
    expect(plan.files[0].content).toContain('uv sync --frozen');
  });

  test('an item already present is skipped, nothing is overwritten', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions'],
      readiness: repo({ files: ['AGENTS.md', 'pyproject.toml'] }),
    });
    expect(plan.files).toEqual([]);
    expect(plan.skipped).toEqual([{ itemId: 'agent-instructions', reason: expect.stringMatching(/already present/i) }]);
  });

  test('a truncated tree cannot prove absence: nothing is scaffolded', () => {
    const plan = planScaffold({ ...base, itemIds: ['agent-instructions', 'env-manifest'], readiness: repo({ truncated: true }) });
    expect(plan.files).toEqual([]);
    expect(plan.skipped.map((s) => s.itemId)).toEqual(['agent-instructions', 'env-manifest']);
  });

  test('items with no scaffold are rejected with a reason', () => {
    const plan = planScaffold({ ...base, itemIds: ['test-command', 'not-an-item'], readiness: repo() });
    expect(plan.files).toEqual([]);
    expect(plan.skipped.map((s) => s.itemId)).toEqual(['test-command', 'not-an-item']);
    expect(plan.skipped.every((s) => s.reason.length > 0)).toBe(true);
  });

  test('a waived item is skipped', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions'],
      readiness: repo({ gitConfig: { onboarding: { waived: { 'agent-instructions': { reason: 'managed elsewhere', at: '2026-01-01' } } } } }),
    });
    expect(plan.files).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/waived/i);
  });

  test('the release workflow is its own PR and needs distinct source and target branches', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions', 'release-path'],
      readiness: repo({ branches: ['develop', 'trunk', 'main'] }),
    });
    const release = plan.files.find((f) => f.group === 'release');
    expect(release?.path).toBe('.github/workflows/release.yml');
    expect(release?.content).toContain('develop');
    expect(plan.prs.map((p) => p.group)).toEqual(['docs', 'release']);
    expect(plan.prs.length).toBeLessThanOrEqual(2);
  });

  test('release workflow without a detectable branch pair is skipped, not guessed', () => {
    const plan = planScaffold({ ...base, itemIds: ['release-path'], readiness: repo({ branches: ['trunk'] }) });
    expect(plan.files).toEqual([]);
    expect(plan.skipped[0].itemId).toBe('release-path');
  });

  test('every scaffoldable id is a known readiness item', () => {
    expect([...SCAFFOLD_ITEM_IDS].sort()).toEqual(
      ['agent-instructions', 'env-manifest', 'release-path', 'spec-format', 'spec-root', 'visual-qa-source'].sort(),
    );
  });

  test('never leaks buildd layout into a stranger repo', () => {
    const plan = planScaffold({
      ...base,
      itemIds: ['agent-instructions', 'spec-root', 'env-manifest'],
      readiness: repo(),
    });
    const all = plan.files.map((f) => f.content).join('\n');
    for (const residue of ['apps/web', 'bun run', 'Neon', 'proxy.ts', 'turbo', 'packages/core']) {
      expect(all).not.toContain(residue);
    }
  });
});

describe('buildScaffoldTaskDescription', () => {
  const plan = planScaffold({ ...base, itemIds: ['agent-instructions', 'release-path'], readiness: repo({ branches: ['develop', 'main'] }) });
  const text = buildScaffoldTaskDescription(plan, { defaultBranch: 'trunk' });

  test('hands over the rendered files as a starting point to verify, not paste', () => {
    expect(text).toContain('CLAUDE.md');
    expect(text).toContain('.github/workflows/release.yml');
    expect(text).toMatch(/verify/i);
    expect(text).toMatch(/not paste|do not paste|don't paste/i);
  });

  test('states the PR and merge rules', () => {
    expect(text).toContain('`trunk`');
    expect(text).toMatch(/one commit per item/i);
    expect(text).toMatch(/separate PR/i);
    expect(text).toMatch(/never (commit|push) .*default branch|do not commit .*default branch/i);
    expect(text).toMatch(/human/i);
  });
});
