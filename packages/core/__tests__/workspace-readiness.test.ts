import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  computeReadiness,
  type ReadinessInput,
  type ReadinessItem,
  type ReadinessItemId,
  type ReadinessReport,
} from '../workspace-readiness';

const item = (r: ReadinessReport, id: ReadinessItemId): ReadinessItem => {
  const found = r.items.find((i) => i.id === id);
  if (!found) throw new Error(`no item ${id}`);
  return found;
};

// ─── Fixture repos ───────────────────────────────────────────────────────────

const nodePnpm: ReadinessInput = {
  files: [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'README.md',
    'src/index.ts',
    '.github/workflows/ci.yml',
  ],
  manifests: {
    'package.json': JSON.stringify({
      scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', build: 'tsc', dev: 'tsx watch src/index.ts' },
    }),
    '.github/workflows/ci.yml': 'jobs:\n  t:\n    steps:\n      - run: pnpm test\n      - run: pnpm run typecheck\n',
  },
};

const pythonUv: ReadinessInput = {
  files: ['pyproject.toml', 'uv.lock', 'README.md', 'src/svc/__init__.py', 'tests/test_svc.py'],
  manifests: {
    'pyproject.toml': '[build-system]\nrequires = ["hatchling"]\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
  },
};

const rust: ReadinessInput = {
  files: ['Cargo.toml', 'Cargo.lock', 'src/main.rs', 'README.md'],
  manifests: { 'Cargo.toml': '[package]\nname = "x"\n' },
};

const go: ReadinessInput = {
  files: ['go.mod', 'go.sum', 'main.go', 'README.md'],
  manifests: { 'go.mod': 'module example.com/x\n' },
};

const empty: ReadinessInput = { files: [], manifests: {} };

const buildddShaped: ReadinessInput = {
  files: [
    'CLAUDE.md',
    'package.json',
    'bun.lock',
    '.buildd/env.yaml',
    'docs/specs/SPEC-FORMAT.md',
    'docs/specs/missions.md',
    'docs/design/merge-policy.md',
    'apps/web/src/app/page.tsx',
    'packages/core/db/schema.ts',
    'packages/core/drizzle/0001_init.sql',
    '.github/workflows/build.yml',
    '.github/workflows/release.yml',
  ],
  manifests: {
    'package.json': JSON.stringify({ scripts: { test: 'bun run scripts/run-unit-tests.ts', build: 'turbo build', 'check-types': 'tsc' } }),
    '.github/workflows/release.yml': 'on:\n  workflow_dispatch:\n    inputs: {}\n',
  },
  gitConfig: { defaultBranch: 'dev' },
  configStatus: 'admin_confirmed',
};

const truncated: ReadinessInput = { files: ['README.md', 'docs/guide.md'], manifests: {}, truncated: true };

// ─── Per-fixture behaviour ───────────────────────────────────────────────────

describe('node/pnpm fixture', () => {
  const r = computeReadiness(nodePnpm);

  it('derives commands from the lockfile-chosen package manager and package.json', () => {
    expect(item(r, 'test-command')).toMatchObject({ status: 'detected', value: 'pnpm run test', fix: null });
    expect(item(r, 'typecheck-command')).toMatchObject({ status: 'detected', value: 'pnpm run typecheck' });
    expect(item(r, 'build-command')).toMatchObject({ status: 'detected', value: 'pnpm run build' });
  });

  it('notes CI corroboration, and lower confidence when CI does not run it', () => {
    expect(item(r, 'test-command').evidence[0].note).toContain('Also run by CI');
    expect(item(r, 'build-command').evidence[0].note).toContain('lower confidence');
  });

  it('proposes scaffolds for what is absent and leaves the rest alone', () => {
    expect(item(r, 'agent-instructions')).toMatchObject({
      status: 'missing',
      fix: { kind: 'scaffold', templateId: 'instructions' },
    });
    expect(item(r, 'spec-root')).toMatchObject({ status: 'missing', fix: { kind: 'scaffold', templateId: 'spec-root' } });
    expect(item(r, 'env-manifest')).toMatchObject({ status: 'missing', fix: { kind: 'scaffold', templateId: 'env-manifest' } });
    expect(r.nextStep).toBe('review-policy');
  });

  it('resolves visual QA to the sandbox from a dev script, with no deployment data', () => {
    expect(item(r, 'visual-qa-source')).toMatchObject({ status: 'detected', value: 'sandbox' });
  });

  it('ignores the npm "no test specified" placeholder', () => {
    const placeholder = computeReadiness({
      files: ['package.json'],
      manifests: { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) },
    });
    expect(item(placeholder, 'test-command').status).toBe('missing');
  });
});

describe('python/uv fixture (AC-2)', () => {
  const r = computeReadiness(pythonUv);

  it('derives test and build from pyproject.toml and the lockfile', () => {
    expect(item(r, 'test-command')).toMatchObject({ status: 'detected', value: 'uv run pytest' });
    expect(item(r, 'build-command')).toMatchObject({ status: 'detected', value: 'uv build' });
    expect(item(r, 'test-command').evidence[0].paths).toContain('pyproject.toml');
  });

  it('reports an untyped project as missing with a waivable owner-decision, not an error', () => {
    expect(item(r, 'typecheck-command')).toMatchObject({
      status: 'missing',
      importance: 'recommended',
      fix: { kind: 'owner-decision' },
    });
    expect(item(r, 'typecheck-command').fix?.summary).toContain('waive');
  });

  it('visual QA has no start command: missing, not unknown', () => {
    expect(item(r, 'visual-qa-source').status).toBe('missing');
  });
});

describe('rust and go fixtures', () => {
  it('uses the toolchain conventions', () => {
    const rs = computeReadiness(rust);
    expect(item(rs, 'test-command').value).toBe('cargo test');
    expect(item(rs, 'typecheck-command').value).toBe('cargo check');
    expect(item(rs, 'build-command').value).toBe('cargo build');
    expect(item(rs, 'test-command').evidence[0].note).toContain('standard command');
    const g = computeReadiness(go);
    expect(item(g, 'test-command').value).toBe('go test ./...');
    expect(item(g, 'typecheck-command').value).toBe('go vet ./...');
    expect(item(g, 'build-command').value).toBe('go build ./...');
  });
});

describe('empty repo', () => {
  const r = computeReadiness(empty);

  it('reports missing (the tree is complete), with an owner-decision for commands', () => {
    for (const id of ['agent-instructions', 'spec-root', 'spec-format', 'test-command', 'merge-policy'] as const) {
      expect(item(r, id).status).toBe('missing');
    }
    expect(item(r, 'test-command').fix?.kind).toBe('owner-decision');
    expect(item(r, 'merge-policy').fix?.kind).toBe('apply-config');
    expect(r.truncated).toBe(false);
    expect(r.nextStep).toBe('review-policy');
  });

  it('a release path is unknowable from an empty repo', () => {
    expect(item(r, 'release-path').status).toBe('unknown');
    expect(item(r, 'migrations-dir')).toMatchObject({ status: 'missing', fix: null });
  });
});

describe('buildd-shaped fixture', () => {
  const r = computeReadiness(buildddShaped);

  it('detects each layout as data, from generic candidates', () => {
    expect(item(r, 'agent-instructions')).toMatchObject({ status: 'detected', value: 'CLAUDE.md' });
    expect(item(r, 'spec-root')).toMatchObject({ status: 'detected', value: 'docs/specs' });
    expect(item(r, 'spec-format')).toMatchObject({ status: 'detected', value: 'docs/specs/SPEC-FORMAT.md' });
    expect(item(r, 'test-command').value).toBe('bun run test');
    expect(item(r, 'typecheck-command').value).toBe('bun run check-types');
    expect(item(r, 'env-manifest').status).toBe('detected');
    expect(item(r, 'migrations-dir')).toMatchObject({
      status: 'detected',
      value: 'packages/core/drizzle',
      fix: { kind: 'apply-config', configPatch: { specConformance: { migrationsDir: 'packages/core/drizzle' } } },
    });
    expect(item(r, 'merge-policy').status).toBe('detected');
    expect(item(r, 'release-path')).toMatchObject({
      status: 'detected',
      fix: {
        kind: 'apply-config',
        configPatch: { releaseConfig: { strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev' } },
      },
    });
  });

  it('next step is the spec-authoring step only when no specs exist', () => {
    expect(r.nextStep).toBe('first-mission');
    const noSpecs = computeReadiness({
      ...buildddShaped,
      files: buildddShaped.files!.filter((f) => f !== 'docs/specs/missions.md'),
    });
    expect(noSpecs.nextStep).toBe('author-spec');
    expect(computeReadiness({ ...buildddShaped, hasMissions: true }).nextStep).toBe('done');
  });

  it('uses the same risk-class detector init does', () => {
    const policy = item(computeReadiness({ ...buildddShaped, configStatus: undefined }), 'merge-policy');
    expect(policy.fix?.kind).toBe('apply-config');
    expect(policy.evidence.some((e) => e.paths?.includes('packages/core/drizzle/'))).toBe(true);
  });
});

// ─── AC-3: truncation ────────────────────────────────────────────────────────

describe('truncated tree (AC-3)', () => {
  const r = computeReadiness(truncated);

  it('reports truncated and never `missing` for anything that depends on absent files', () => {
    expect(r.truncated).toBe(true);
    expect(r.items.filter((i) => i.status === 'missing')).toEqual([]);
    for (const id of ['agent-instructions', 'spec-root', 'spec-format', 'test-command', 'env-manifest', 'merge-policy', 'visual-qa-source'] as const) {
      expect(item(r, id).status).toBe('unknown');
      expect(item(r, id).fix).toBeNull();
    }
  });

  it('a file that is present still counts: presence is definitive, absence is not', () => {
    const r2 = computeReadiness({ ...truncated, files: [...truncated.files!, 'CLAUDE.md'] });
    expect(item(r2, 'agent-instructions').status).toBe('detected');
    expect(item(r2, 'spec-root').status).toBe('unknown');
  });

  it('does not claim an unfinished spec step from a partial tree', () => {
    const r3 = computeReadiness({ ...truncated, files: ['docs/specs/SPEC-FORMAT.md'], configStatus: 'admin_confirmed' });
    expect(r3.nextStep).toBe('first-mission');
  });
});

describe('unreadable manifests', () => {
  it('a package.json that was not read makes command detection unknown, not missing', () => {
    const r = computeReadiness({ files: ['package.json', 'pnpm-lock.yaml'], manifests: {} });
    expect(item(r, 'test-command')).toMatchObject({ status: 'unknown', fix: null });
    expect(item(r, 'visual-qa-source').status).toBe('unknown');
  });

  it('manifests only in subdirectories are not reported as no toolchain', () => {
    const r = computeReadiness({ files: ['backend/pyproject.toml', 'web/package.json'], manifests: {} });
    expect(item(r, 'test-command').status).toBe('unknown');
    expect(item(r, 'test-command').evidence[0].paths).toContain('backend/pyproject.toml');
  });
});

describe('no repo', () => {
  it('links the repo first and knows nothing else', () => {
    const r = computeReadiness({ files: null });
    expect(r.nextStep).toBe('link-repo');
    expect(r.items.every((i) => i.status === 'unknown' && i.fix === null)).toBe(true);
  });
});

// ─── spec-format ─────────────────────────────────────────────────────────────

describe('spec-format', () => {
  const specs = (manifests: Record<string, string>, files: string[]) =>
    computeReadiness({ files: ['specs/a.md', 'specs/b.md', ...files], manifests });

  it('accepts consistent frontmatter across readable specs', () => {
    const fm = '---\ntitle: x\nstatus: draft\n---\nbody';
    const r = specs({ 'specs/a.md': fm, 'specs/b.md': fm }, []);
    expect(item(r, 'spec-format').status).toBe('detected');
  });

  it('existing specs without a format doc are an owner decision, not a scaffold', () => {
    const r = specs({ 'specs/a.md': '# a', 'specs/b.md': '---\nx: 1\n---' }, []);
    expect(item(r, 'spec-format')).toMatchObject({ status: 'missing', fix: { kind: 'owner-decision' } });
  });

  it('an empty spec root asks for a scaffolded format doc', () => {
    const r = computeReadiness({ files: ['specs/.gitkeep', 'specs/notes.txt'], manifests: {} });
    expect(item(r, 'spec-root').status).toBe('detected');
    expect(item(r, 'spec-format')).toMatchObject({ status: 'missing', fix: { kind: 'scaffold', templateId: 'spec-format' } });
  });
});

// ─── release-path ────────────────────────────────────────────────────────────

describe('release-path', () => {
  it('prefers configured releases', () => {
    const r = computeReadiness({ files: [], releaseConfig: { enabled: true, strategy: 'branch_merge' } });
    expect(item(r, 'release-path')).toMatchObject({ status: 'detected', value: 'branch_merge', fix: null });
  });

  it('finds a release script', () => {
    const r = computeReadiness({
      files: ['package.json', 'yarn.lock'],
      manifests: { 'package.json': JSON.stringify({ scripts: { release: 'np' } }) },
    });
    expect(item(r, 'release-path').fix?.configPatch).toEqual({
      releaseConfig: { enabled: true, strategy: 'script', command: 'yarn run release' },
    });
  });

  it('reads long-lived branches', () => {
    const r = computeReadiness({ files: ['a.txt'], branches: ['main', 'develop', 'feature/x'] });
    expect(item(r, 'release-path').fix?.configPatch).toEqual({
      releaseConfig: { enabled: true, strategy: 'branch_merge', prodBranch: 'main', releaseBranch: 'develop' },
    });
  });

  it('a release-shaped workflow whose trigger was not read stays unknown', () => {
    const r = computeReadiness({ files: ['.github/workflows/publish.yml'], manifests: {} });
    expect(item(r, 'release-path').status).toBe('unknown');
    expect(item(r, 'release-path').evidence[0].paths).toContain('.github/workflows/publish.yml');
  });

  it('a workflow without workflow_dispatch is not a dispatchable release path', () => {
    const r = computeReadiness({
      files: ['.github/workflows/release.yml'],
      manifests: { '.github/workflows/release.yml': 'on:\n  push:\n    tags: ["v*"]\n' },
    });
    expect(item(r, 'release-path').status).toBe('unknown');
  });
});

// ─── AC-15: visual-qa-source never errors, never requires a preview source ───

describe('visual-qa-source (AC-15)', () => {
  const withStart: ReadinessInput = {
    files: ['package.json'],
    manifests: { 'package.json': JSON.stringify({ scripts: { start: 'node .' } }) },
  };

  const noDeploymentCases: Array<[string, ReadinessInput['deployments']]> = [
    ['null', null],
    ['empty', []],
  ];
  it.each(noDeploymentCases)('resolves to sandbox or missing with deployments=%s', (_label, deployments) => {
    const sandbox = computeReadiness({ ...withStart, deployments });
    expect(item(sandbox, 'visual-qa-source').status).toBe('detected');
    expect(item(sandbox, 'visual-qa-source').value).toBe('sandbox');
    const none = computeReadiness({ files: ['README.md'], deployments });
    expect(item(none, 'visual-qa-source').status).toBe('missing');
    expect(none.items).toHaveLength(computeReadiness({ files: ['README.md'] }).items.length);
  });

  it('non-preview deployments do not make a preview source a candidate', () => {
    const r = computeReadiness({ ...withStart, deployments: [{ environment: 'Production', state: 'success' }] });
    expect(item(r, 'visual-qa-source').value).toBe('sandbox');
  });

  it('preview deployments need the preview detector; until it is bound the answer is unknown', () => {
    const r = computeReadiness({
      ...withStart,
      deployments: [{ environment: 'Preview', state: 'success', environmentUrl: 'https://example.test' }],
    });
    expect(item(r, 'visual-qa-source')).toMatchObject({ status: 'unknown', fix: null });
    expect(item(r, 'visual-qa-source').evidence[0].note).toContain('preview detection not available');
  });
});

// ─── Waivers ─────────────────────────────────────────────────────────────────

describe('waivers', () => {
  it('annotates the item and stops it driving the next step', () => {
    const waived = { reason: 'not for this repo', at: '2026-01-01T00:00:00Z' };
    const base: ReadinessInput = { files: ['package.json'], manifests: { 'package.json': '{}' }, configStatus: 'admin_confirmed' };
    expect(computeReadiness(base).nextStep).toBe('propose-fixes');
    const r = computeReadiness({
      ...base,
      gitConfig: { onboarding: { waived: Object.fromEntries(['agent-instructions', 'spec-root', 'spec-format', 'test-command'].map((k) => [k, waived])) } },
    });
    expect(item(r, 'test-command').waived).toEqual(waived);
    expect(r.nextStep).toBe('first-mission');
  });
});

// ─── AC-16: the new gitConfig.onboarding field is a no-op when absent ───────

describe('gitConfig.onboarding absence changes nothing (AC-16)', () => {
  it('an entirely absent gitConfig reads identically to an explicit empty one', () => {
    const noGitConfig = computeReadiness({ files: ['package.json'], manifests: { 'package.json': '{}' } });
    const emptyGitConfig = computeReadiness({ files: ['package.json'], manifests: { 'package.json': '{}' }, gitConfig: {} });
    expect(noGitConfig).toEqual(emptyGitConfig);
  });

  it('gitConfig with no onboarding key reads identically to onboarding present but empty', () => {
    const withoutOnboarding = computeReadiness({ ...buildddShaped, gitConfig: { defaultBranch: 'dev' } });
    const withEmptyOnboarding = computeReadiness({
      ...buildddShaped,
      gitConfig: { defaultBranch: 'dev', onboarding: {} },
    });
    expect(withoutOnboarding).toEqual(withEmptyOnboarding);
  });

  it('a pre-existing workspace with other gitConfig fields set, but no onboarding key, is unaffected', () => {
    const r = computeReadiness({
      ...buildddShaped,
      gitConfig: { defaultBranch: 'dev', specConformance: { specsRoot: 'docs/specs' } },
    });
    expect(item(r, 'merge-policy').waived).toBeUndefined();
    expect(r.nextStep).not.toBe('link-repo');
  });
});

// ─── AC-1: no buildd-shaped output for non-buildd repos ──────────────────────

const BUILDD_SHAPED = [
  /\bbun\b/i,
  /\bapps\//,
  /docs\/specs/,
  /docs\/design/,
  /packages\/core/,
  /buildd/i,
  /next\.?js/i,
  /turbo/i,
  /neon/i,
  /proxy\.ts/,
  /drizzle/i,
];

describe('no buildd-shaped output for non-buildd fixtures (AC-1)', () => {
  const fixtures: Array<[string, ReadinessInput]> = [
    ['node/pnpm', nodePnpm],
    ['python/uv', pythonUv],
    ['rust', rust],
    ['go', go],
    ['empty', empty],
    ['truncated', truncated],
    ['no repo', { files: null }],
    ['rails-ish', { files: ['Gemfile', 'Gemfile.lock', 'app/models/user.rb', 'db/migrate/001_x.rb', 'spec/user_spec.rb'] }],
  ];

  it.each(fixtures)('%s', (_name, input) => {
    const text = JSON.stringify(computeReadiness({ ...input, deployments: null }));
    for (const rx of BUILDD_SHAPED) expect(text).not.toMatch(rx);
  });

  it('finds a migrations dir and spec root in a non-buildd layout by candidate list alone', () => {
    const r = computeReadiness({ files: ['Gemfile', 'db/migrate/001_x.rb', 'spec/user_spec.rb'] });
    expect(item(r, 'migrations-dir').value).toBe('db/migrate');
    expect(item(r, 'spec-root').value).toBe('spec');
  });

  it('the detector sources name no buildd-shaped path or toolchain outside candidate lists', () => {
    const dir = join(import.meta.dir, '..', 'readiness');
    const banned = [/\bbun\b/i, /next\.?js/i, /docs\/specs/, /docs\/design/, /apps\/(?:web|runner)/];
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8')
        // comments may describe the rule itself
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      for (const rx of banned) expect(`${f}: ${src.match(rx)?.[0] ?? ''}`).toBe(`${f}: `);
    }
  });
});

describe('determinism', () => {
  it('is a pure function of its input', () => {
    expect(computeReadiness(buildddShaped)).toEqual(computeReadiness(structuredClone(buildddShaped)));
  });
});
