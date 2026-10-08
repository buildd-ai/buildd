import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { dirname, join, normalize } from 'path';
import {
  buildGraph,
  decideMode,
  formatLog,
  packageJsonResolutionChange,
  selectAffected,
  uniqueSuffix,
  type Repo,
  type Selection,
} from './affected-tests';

/**
 * An in-memory repo: `files` is path -> HEAD source, `base` is path -> base
 * source (for package.json comparisons). Resolution mimics Bun's for what the
 * tests need: relative paths with extension and index probing, and an `@lib/`
 * alias standing in for tsconfig paths / workspace exports.
 */
function fakeRepo(files: Record<string, string>, base: Record<string, string> = {}): Repo {
  const paths = Object.keys(files);
  const probe = (p: string) => [p, `${p}.ts`, `${p}.tsx`, `${p}.mjs`, `${p}/index.ts`].find(c => c in files);
  return {
    files: paths,
    read: p => files[p],
    readBase: p => base[p],
    resolve(spec, from) {
      if (spec.startsWith('@lib/')) {
        const hit = probe(`packages/lib/${spec.slice(5)}`);
        return hit ? { kind: 'local', path: hit } : { kind: 'unresolved' };
      }
      if (spec.startsWith('.')) {
        const hit = probe(normalize(join(dirname(from), spec)));
        return hit ? { kind: 'local', path: hit } : { kind: 'unresolved' };
      }
      return spec.startsWith('node:') || spec === 'bun:test' || spec === 'react' ? { kind: 'external' } : { kind: 'unresolved' };
    },
  };
}

const isTest = (p: string) => p.endsWith('.test.ts');

function run(files: Record<string, string>, changed: string[], opts: { base?: Record<string, string>; alwaysRun?: string[]; ceiling?: number } = {}): Selection {
  const repo = fakeRepo(files, opts.base);
  return selectAffected({ changed, repo, graph: buildGraph(repo), alwaysRun: opts.alwaysRun ?? [], isTest, ceiling: opts.ceiling ?? 1 });
}

const listed = (s: Selection): string[] => {
  if (s.kind !== 'LIST') throw new Error(`expected a list, got ${s.kind}: ${'reason' in s ? s.reason : ''}`);
  return s.tests;
};

// A small app: two leaves, a hub that imports one, and tests over each.
const APP: Record<string, string> = {
  'app/a.ts': `export const a = 1;`,
  'app/b.ts': `export const b = 2;`,
  'app/hub.ts': `import { a } from './a';\nexport const hub = a;`,
  'app/a.test.ts': `import { a } from './a';`,
  'app/b.test.ts': `import { b } from './b';`,
  'app/hub.test.ts': `import { hub } from './hub';`,
  'app/unrelated.test.ts': `import { expect } from 'bun:test';`,
};

describe('reverse import graph selection', () => {
  test('selects tests that import a changed file transitively, not just the one beside it', () => {
    expect(listed(run(APP, ['app/a.ts']))).toEqual(['app/a.test.ts', 'app/hub.test.ts']);
  });

  test('a leaf nobody else imports selects only its own test', () => {
    expect(listed(run(APP, ['app/b.ts']))).toEqual(['app/b.test.ts']);
  });

  test('a changed test file selects itself', () => {
    expect(listed(run(APP, ['app/unrelated.test.ts']))).toEqual(['app/unrelated.test.ts']);
  });

  test('resolves aliases and index files', () => {
    const files = {
      'packages/lib/util/index.ts': `export const u = 1;`,
      'app/uses.ts': `export { u } from '@lib/util';`,
      'app/uses.test.ts': `import { u } from './uses';`,
    };
    expect(listed(run(files, ['packages/lib/util/index.ts']))).toEqual(['app/uses.test.ts']);
  });

  test('follows re-exports, dynamic literal imports and type-erased modules', () => {
    const files = {
      'app/a.ts': `export const a = 1;`,
      'app/lazy.ts': `export async function f() { return (await import('./a')).a; }`,
      'app/lazy.test.ts': `import { f } from './lazy';`,
    };
    expect(listed(run(files, ['app/a.ts']))).toEqual(['app/lazy.test.ts']);
  });

  test('a test that mocks a changed module is selected even if it never imports it', () => {
    const files = {
      'app/dep.ts': `export const dep = 1;`,
      'app/mocker.test.ts': `import { mock } from 'bun:test';\nmock.module('./dep', () => ({ dep: 2 }));`,
    };
    expect(listed(run(files, ['app/dep.ts']))).toEqual(['app/mocker.test.ts']);
  });

  test('the reason names the changed file and the hop nearest the test', () => {
    const s = run(APP, ['app/a.ts']);
    if (s.kind !== 'LIST') throw new Error('expected list');
    expect(s.reasons.get('app/hub.test.ts')).toBe('app/hub.test.ts ← imports app/a.ts (via app/hub.ts)');
    expect(s.reasons.get('app/a.test.ts')).toBe('app/a.test.ts ← imports app/a.ts');
  });

  test('a test with a computed import() can load anything, so it is always selected', () => {
    const files = { ...APP, 'app/loader.test.ts': `const m = await import(\`./\${name}\`);` };
    expect(listed(run(files, ['app/b.ts']))).toEqual(['app/b.test.ts', 'app/loader.test.ts']);
  });

  test('always-run entries join every selection, and keep a docs-only change from SKIPping', () => {
    const files = { ...APP, 'README.md': '# hi' };
    expect(listed(run(files, ['README.md'], { alwaysRun: ['app/unrelated.test.ts'] }))).toEqual(['app/unrelated.test.ts']);
  });

  test('nothing reachable and no invariants is SKIP; an empty diff is SKIP', () => {
    expect(run({ ...APP, 'README.md': '# hi' }, ['README.md']).kind).toBe('SKIP');
    expect(run(APP, []).kind).toBe('SKIP');
  });

  test('a deleted file selects tests that still import it', () => {
    const files = { 'app/user.ts': `import { gone } from './gone';`, 'app/user.test.ts': `import './user';` };
    expect(listed(run(files, ['app/gone.ts']))).toEqual(['app/user.test.ts']);
  });
});

describe('reference scan: files tests read or spawn by path', () => {
  test('a data file named by a test selects that test', () => {
    const files = { ...APP, 'app/manifest.json': '{}', 'app/manifest.test.ts': `readFileSync('app/manifest.json')` };
    expect(listed(run(files, ['app/manifest.json']))).toEqual(['app/manifest.test.ts']);
  });

  test('a library that reads a data file by path carries its importers', () => {
    const files = {
      'cfg/data/table.json': '{}',
      'app/reader.ts': `import { readFileSync } from 'node:fs';\nexport const t = readFileSync('cfg/data/table.json', 'utf8');`,
      'app/reader.test.ts': `import { t } from './reader';`,
    };
    expect(listed(run(files, ['cfg/data/table.json']))).toEqual(['app/reader.test.ts']);
  });

  test('a library that only lists a path as data, or names it in a comment, does not', () => {
    const files = {
      'docs/specs/x.md': '# x',
      'app/policy.ts': `// see docs/specs/x.md\nexport const GENERATED = ['docs/specs/x.md'];`,
      'app/policy.test.ts': `import { GENERATED } from './policy';`,
    };
    expect(run(files, ['docs/specs/x.md']).kind).toBe('SKIP');
  });

  test('a new file in a directory a test lists selects that test', () => {
    const files = {
      'db/migrations/0002_new.sql': 'select 1',
      'db/journal.test.ts': `const dir = join(import.meta.dir, 'migrations'); readdirSync(dir);`,
    };
    expect(listed(run(files, ['db/migrations/0002_new.sql']))).toEqual(['db/journal.test.ts']);
  });

  test('a spawned script a test names by path selects it; the same name in a comment does not', () => {
    const files = {
      'tools/gen.mjs': `console.log(1)`,
      'tools/gen.test.ts': `spawnSync('node', ['tools/gen.mjs'])`,
      'tools/other.test.ts': `// tools/gen.mjs is unrelated here`,
    };
    expect(listed(run(files, ['tools/gen.mjs']))).toEqual(['tools/gen.test.ts']);
  });

  test('uniqueSuffix finds the shortest unambiguous tail', () => {
    const files = ['a/x/route.ts', 'b/y/route.ts', 'c/only.json'];
    expect(uniqueSuffix('a/x/route.ts', files)).toBe('x/route.ts');
    expect(uniqueSuffix('c/only.json', files)).toBe('only.json');
  });
});

describe('fail safe to ALL', () => {
  const kindFor = (changed: string[], extra: Record<string, string> = {}, base: Record<string, string> = {}) =>
    run({ ...APP, ...extra }, changed, { base });

  test.each([
    'bun.lock',
    'bunfig.toml',
    'packages/core/bunfig.toml',
    'tsconfig.json',
    'apps/web/tsconfig.json',
    'tests/setup.ts',
    'scripts/run-unit-tests.ts',
    'scripts/affected-tests.ts',
    'scripts/affected-tests.sh',
    'patches/some-dep@1.0.0.patch',
  ])('%s', file => {
    const s = kindFor([file]);
    expect(s.kind).toBe('ALL');
    expect('reason' in s && s.reason).toContain(file);
  });

  test('a change inside the preload closure reaches every test', () => {
    const s = kindFor(['app/setup-helper.ts'], {
      'tests/setup.ts': `import './../app/setup-helper';`,
      'app/setup-helper.ts': `export {}`,
    });
    expect(s.kind).toBe('ALL');
  });

  test('package.json: a dependency change is ALL, a version bump is not', () => {
    const base = { 'pkg/package.json': JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { x: '1' } }) };
    const bumped = { 'pkg/package.json': JSON.stringify({ name: 'p', version: '1.0.1', dependencies: { x: '1' } }) };
    const dep = { 'pkg/package.json': JSON.stringify({ name: 'p', version: '1.0.0', dependencies: { x: '2' } }) };
    expect(kindFor(['pkg/package.json'], bumped, base).kind).toBe('SKIP');
    expect(kindFor(['pkg/package.json'], dep, base).kind).toBe('ALL');
    expect(packageJsonResolutionChange(dep['pkg/package.json'], undefined)).toBe('added or removed');
    expect(packageJsonResolutionChange('{bad', '{}')).toBe('unparseable');
  });

  test('a changed file whose imports cannot be followed', () => {
    expect(kindFor(['app/broken.ts'], { 'app/broken.ts': `import { x } from './missing';` }).kind).toBe('ALL');
    expect(kindFor(['app/bad.ts'], { 'app/bad.ts': `export const = ;` }).kind).toBe('ALL');
  });

  test('an unresolvable import in an UNCHANGED file does not force ALL', () => {
    expect(kindFor(['app/b.ts'], { 'app/broken.ts': `import { x } from './missing';` }).kind).toBe('LIST');
  });

  test('code outside the TS graph that nothing imports or names', () => {
    expect(kindFor(['ops/deploy.sh'], { 'ops/deploy.sh': 'echo hi' }).kind).toBe('ALL');
    expect(kindFor(['ops/build.mjs'], { 'ops/build.mjs': 'console.log(1)' }).kind).toBe('ALL');
  });

  test('over the ceiling says ALL', () => {
    const s = run(APP, ['app/a.ts'], { ceiling: 0.2 });
    expect(s.kind).toBe('ALL');
    expect('reason' in s && s.reason).toContain('over 20%');
  });

  test('a big diff is no longer ALL by size alone', () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 30; i++) many[`docs/note${i}.md`] = 'x';
    expect(run({ ...APP, ...many }, [...Object.keys(many), 'app/b.ts']).kind).toBe('LIST');
  });
});

describe('mode', () => {
  test('pushes and PRs into main always run everything', () => {
    expect(decideMode({ GITHUB_EVENT_NAME: 'push', GITHUB_REF_NAME: 'dev' }).kind).toBe('ALL');
    expect(decideMode({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'main' }).kind).toBe('ALL');
  });

  test('PRs into dev and mission branches diff against their base', () => {
    expect(decideMode({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'dev' })).toEqual({ kind: 'DIFF', base: 'origin/dev', label: 'PR into dev' });
    expect(decideMode({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_BASE_REF: 'mission/x' })).toMatchObject({ kind: 'DIFF', base: 'origin/mission/x' });
  });

  test('a local run diffs against origin/dev', () => {
    expect(decideMode({})).toMatchObject({ kind: 'DIFF', base: 'origin/dev' });
  });
});

describe('logging', () => {
  test('ALL says why; a list says how many and gives three example reasons', () => {
    expect(formatLog({ kind: 'ALL', reason: 'bun.lock changed' }, 1, 10)).toEqual(['Running ALL unit tests: bun.lock changed']);
    const reasons = new Map([
      ['a.test.ts', 'a.test.ts ← imports a.ts'],
      ['b.test.ts', 'b.test.ts ← imports a.ts (via b.ts)'],
      ['c.test.ts', 'c.test.ts ← mentions d.json'],
      ['d.test.ts', 'd.test.ts ← imports a.ts (via e.ts)'],
      ['z.test.ts', 'z.test.ts ← always-run manifest'],
    ]);
    const lines = formatLog({ kind: 'LIST', tests: [...reasons.keys()], reasons }, 2, 100);
    expect(lines[0]).toBe('Selected 5 of 100 test files for 2 changed file(s)');
    expect(lines.slice(1)).toEqual(['  a.test.ts ← imports a.ts', '  b.test.ts ← imports a.ts (via b.ts)', '  c.test.ts ← mentions d.json']);
  });
});

describe('against the real repo', () => {
  const runCli = (changed: string[]) => {
    const out = spawnSync('bun', ['scripts/affected-tests.ts'], {
      encoding: 'utf8',
      env: { ...process.env, AFFECTED_TESTS_CHANGED: changed.join('\n'), GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '' },
    });
    return { last: (out.stdout ?? '').trim().split('\n').at(-1) ?? '', log: out.stderr ?? '' };
  };

  test('a packages/core change selects tests far from it, without falling back to ALL', () => {
    const { last, log } = runCli(['packages/core/mcp-tools.ts']);
    const tests = last.split(' ');
    expect(last).not.toBe('ALL');
    expect(tests).toContain('apps/web/src/app/api/mcp/tools.test.ts');
    expect(log).toContain('← imports packages/core/mcp-tools.ts');
  });

  test('a new migration selects the journal tests', () => {
    const { last } = runCli(['packages/core/drizzle/9999_new.sql', 'packages/core/drizzle/meta/_journal.json']);
    const tests = last.split(' ');
    expect(tests).toContain('packages/core/__tests__/migration-journal.test.ts');
    expect(tests).toContain('packages/core/__tests__/migration-journal-ordering.test.ts');
  });

  test('the wrapper script still prints the same contract', () => {
    const out = spawnSync('bash', ['scripts/affected-tests.sh'], {
      encoding: 'utf8',
      env: { ...process.env, AFFECTED_TESTS_CHANGED: 'bun.lock', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '' },
    });
    expect((out.stdout ?? '').trim().split('\n').at(-1)).toBe('ALL');
  });
});
