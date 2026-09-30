import { describe, it, expect } from 'bun:test';
import {
  LOCKFILE_RULES,
  detectEcosystems,
  findLockfileRule,
  type CommandCandidate,
  type DetectedEcosystem,
} from '../ecosystem-detect';

const commands = (c: CommandCandidate[]) => c.map((x) => x.command);
const only = (files: string[], manifests?: Record<string, string>): DetectedEcosystem => {
  const found = detectEcosystems({ files, manifests });
  expect(found).toHaveLength(1);
  return found[0];
};

describe('LOCKFILE_RULES / findLockfileRule', () => {
  it('keeps the historical first-match-wins order', () => {
    expect(LOCKFILE_RULES.map((r) => r.lockfile)).toEqual([
      'bun.lock',
      'bun.lockb',
      'pnpm-lock.yaml',
      'yarn.lock',
      'package-lock.json',
      'uv.lock',
      'poetry.lock',
      'Cargo.lock',
      'go.sum',
    ]);
  });

  it('keeps the runtime + install strings env-verify has always planned', () => {
    const by = Object.fromEntries(LOCKFILE_RULES.map((r) => [r.lockfile, [r.runtime, r.install]]));
    expect(by['bun.lock']).toEqual(['bun', 'bun install --frozen-lockfile']);
    expect(by['pnpm-lock.yaml']).toEqual(['pnpm', 'pnpm install --frozen-lockfile']);
    expect(by['yarn.lock']).toEqual(['yarn', 'yarn install --frozen-lockfile']);
    expect(by['package-lock.json']).toEqual(['node', 'npm ci']);
    expect(by['uv.lock']).toEqual(['uv', 'uv sync --frozen']);
    expect(by['poetry.lock']).toEqual(['python3', 'poetry install']);
    expect(by['Cargo.lock']).toEqual(['cargo', 'cargo fetch --locked']);
    expect(by['go.sum']).toEqual(['go', 'go mod download']);
  });

  it('returns the first rule whose lockfile exists', () => {
    const present = new Set(['package-lock.json', 'bun.lock']);
    expect(findLockfileRule((p) => present.has(p))?.lockfile).toBe('bun.lock');
  });

  it('returns null when no lockfile exists', () => {
    expect(findLockfileRule(() => false)).toBeNull();
  });
});

describe('detectEcosystems — empty / unrecognised', () => {
  it('detects nothing in an empty repo', () => {
    expect(detectEcosystems({ files: [] })).toEqual([]);
  });

  it('detects nothing when no marker files are present', () => {
    expect(detectEcosystems({ files: ['README.md', 'src/main.c', 'docs/a.md'] })).toEqual([]);
  });

  it('only looks at the repo root', () => {
    expect(detectEcosystems({ files: ['packages/app/package.json', 'sub/Cargo.toml'] })).toEqual([]);
  });

  it('normalises leading ./ on paths', () => {
    expect(only(['./pnpm-lock.yaml']).packageManager).toBe('pnpm');
  });
});

describe('detectEcosystems — node', () => {
  it.each([
    ['bun.lock', 'bun', 'bun install --frozen-lockfile'],
    ['bun.lockb', 'bun', 'bun install --frozen-lockfile'],
    ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'yarn', 'yarn install --frozen-lockfile'],
    ['package-lock.json', 'npm', 'npm ci'],
  ])('%s -> %s', (lockfile, pm, install) => {
    const e = only(['package.json', lockfile]);
    expect(e.ecosystem).toBe('node');
    expect(e.packageManager).toBe(pm);
    expect(e.lockfile).toBe(lockfile);
    expect(e.install[0]).toMatchObject({ command: install, confidence: 'high' });
  });

  it('detects node from a lockfile alone', () => {
    expect(only(['pnpm-lock.yaml']).packageManager).toBe('pnpm');
  });

  it('prefers the first lockfile when several exist (bun over npm)', () => {
    const e = only(['package.json', 'package-lock.json', 'bun.lock']);
    expect(e.packageManager).toBe('bun');
  });

  it('a bare package.json defaults to npm, not bun, at low confidence', () => {
    const e = only(['package.json']);
    expect(e.packageManager).toBe('npm');
    expect(e.lockfile).toBeNull();
    expect(e.install).toEqual([
      { command: 'npm install', source: 'manifest', confidence: 'low' },
    ]);
  });

  it('honours the package.json packageManager field when there is no lockfile', () => {
    const e = only(['package.json'], {
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
    });
    expect(e.packageManager).toBe('pnpm');
    expect(commands(e.install)).toEqual(['pnpm install']);
  });

  it('a lockfile beats the packageManager field', () => {
    const e = only(['package.json', 'yarn.lock'], {
      'package.json': JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
    });
    expect(e.packageManager).toBe('yarn');
  });

  it('derives test/typecheck/build from package.json scripts using the detected manager', () => {
    const e = only(['package.json', 'pnpm-lock.yaml'], {
      'package.json': JSON.stringify({
        scripts: { test: 'vitest', 'check-types': 'tsc --noEmit', build: 'next build', lint: 'eslint .' },
      }),
    });
    expect(commands(e.test)).toEqual(['pnpm run test']);
    expect(commands(e.typecheck)).toEqual(['pnpm run check-types']);
    expect(commands(e.build)).toEqual(['pnpm run build']);
    expect(e.test[0]).toMatchObject({ source: 'manifest', confidence: 'high' });
  });

  it('uses each manager\'s own run syntax', () => {
    const scripts = JSON.stringify({ scripts: { test: 'x' } });
    const run = (lock: string) =>
      commands(only(['package.json', lock], { 'package.json': scripts }).test)[0];
    expect(run('bun.lock')).toBe('bun run test');
    expect(run('yarn.lock')).toBe('yarn run test');
    expect(run('package-lock.json')).toBe('npm run test');
  });

  it('recognises alternative typecheck script names, preferring the most explicit', () => {
    const e = only(['package.json'], {
      'package.json': JSON.stringify({ scripts: { tsc: 'tsc', typecheck: 'tsc --noEmit' } }),
    });
    expect(commands(e.typecheck)).toEqual(['npm run typecheck', 'npm run tsc']);
  });

  it('reports no script-derived commands without scripts (nothing is guessed)', () => {
    const e = only(['package.json', 'package-lock.json'], { 'package.json': '{"name":"x"}' });
    expect(e.test).toEqual([]);
    expect(e.typecheck).toEqual([]);
    expect(e.build).toEqual([]);
  });

  it('tolerates a malformed package.json', () => {
    const e = only(['package.json', 'package-lock.json'], { 'package.json': '{nope' });
    expect(e.packageManager).toBe('npm');
    expect(e.test).toEqual([]);
  });
});

describe('detectEcosystems — python', () => {
  it('uv.lock -> uv', () => {
    const e = only(['pyproject.toml', 'uv.lock']);
    expect(e.ecosystem).toBe('python');
    expect(e.packageManager).toBe('uv');
    expect(e.install[0]).toMatchObject({ command: 'uv sync --frozen', confidence: 'high' });
  });

  it('poetry.lock -> poetry', () => {
    const e = only(['pyproject.toml', 'poetry.lock']);
    expect(e.packageManager).toBe('poetry');
    expect(commands(e.install)).toEqual(['poetry install']);
  });

  it('requirements.txt alone -> pip', () => {
    const e = only(['requirements.txt']);
    expect(e.packageManager).toBe('pip');
    expect(e.lockfile).toBeNull();
    expect(e.install[0]).toMatchObject({ command: 'pip install -r requirements.txt', confidence: 'low' });
  });

  it('bare pyproject.toml -> pip editable install', () => {
    const e = only(['pyproject.toml']);
    expect(e.packageManager).toBe('pip');
    expect(commands(e.install)).toEqual(['pip install -e .']);
  });

  it('a [tool.poetry] table selects poetry without a lockfile', () => {
    const e = only(['pyproject.toml'], { 'pyproject.toml': '[tool.poetry]\nname = "x"\n' });
    expect(e.packageManager).toBe('poetry');
    expect(commands(e.install)).toEqual(['poetry install']);
  });

  it('a [tool.uv] table selects uv without a lockfile', () => {
    const e = only(['pyproject.toml'], { 'pyproject.toml': '[tool.uv]\ndev-dependencies = []\n' });
    expect(e.packageManager).toBe('uv');
    expect(commands(e.install)).toEqual(['uv sync']);
  });

  it('derives pytest / mypy candidates wrapped in the detected manager', () => {
    const e = only(['pyproject.toml', 'uv.lock'], {
      'pyproject.toml': '[tool.pytest.ini_options]\n[tool.mypy]\nstrict = true\n',
    });
    expect(commands(e.test)).toEqual(['uv run pytest']);
    expect(commands(e.typecheck)).toEqual(['uv run mypy .']);
  });

  it('wraps poetry and leaves pip bare', () => {
    const poetry = only(['pyproject.toml', 'poetry.lock'], { 'pyproject.toml': '[tool.pytest.ini_options]\n' });
    expect(commands(poetry.test)).toEqual(['poetry run pytest']);
    const pip = only(['requirements.txt', 'pytest.ini']);
    expect(commands(pip.test)).toEqual(['pytest']);
  });

  it('a pytest config file alone is enough evidence for a test command', () => {
    expect(commands(only(['pyproject.toml', 'pytest.ini']).test)).toEqual(['pytest']);
  });

  it('reports no typecheck command for an untyped project', () => {
    expect(only(['pyproject.toml', 'uv.lock']).typecheck).toEqual([]);
  });
});

describe('detectEcosystems — rust and go', () => {
  it('Cargo.lock -> cargo with locked fetch and conventional commands', () => {
    const e = only(['Cargo.toml', 'Cargo.lock']);
    expect(e.ecosystem).toBe('rust');
    expect(e.packageManager).toBe('cargo');
    expect(e.install[0]).toMatchObject({ command: 'cargo fetch --locked', confidence: 'high' });
    expect(commands(e.test)).toEqual(['cargo test']);
    expect(commands(e.typecheck)).toEqual(['cargo check']);
    expect(commands(e.build)).toEqual(['cargo build']);
    expect(e.test[0].source).toBe('convention');
  });

  it('Cargo.toml without a lockfile fetches unlocked at low confidence', () => {
    const e = only(['Cargo.toml']);
    expect(e.lockfile).toBeNull();
    expect(e.install[0]).toMatchObject({ command: 'cargo fetch', confidence: 'low' });
  });

  it('go.sum -> go modules', () => {
    const e = only(['go.mod', 'go.sum']);
    expect(e.ecosystem).toBe('go');
    expect(e.packageManager).toBe('go');
    expect(e.install[0]).toMatchObject({ command: 'go mod download', confidence: 'high' });
    expect(commands(e.test)).toEqual(['go test ./...']);
    expect(commands(e.typecheck)).toEqual(['go vet ./...']);
    expect(commands(e.build)).toEqual(['go build ./...']);
  });

  it('go.mod without go.sum is still detected', () => {
    const e = only(['go.mod']);
    expect(e.ecosystem).toBe('go');
    expect(e.lockfile).toBeNull();
  });
});

describe('detectEcosystems — polyglot and layout independence', () => {
  it('returns every ecosystem in table order', () => {
    const found = detectEcosystems({ files: ['go.mod', 'uv.lock', 'pnpm-lock.yaml', 'Cargo.toml'] });
    expect(found.map((e) => e.ecosystem)).toEqual(['node', 'python', 'rust', 'go']);
  });

  it('never invents bun for a non-bun repo', () => {
    for (const files of [['package.json'], ['package-lock.json'], ['pnpm-lock.yaml'], ['yarn.lock'], ['uv.lock'], ['Cargo.lock'], ['go.sum']]) {
      expect(JSON.stringify(detectEcosystems({ files }))).not.toContain('bun');
    }
  });

  it('does not key off buildd-shaped paths', () => {
    expect(
      detectEcosystems({ files: ['apps/web/src/app/page.tsx', 'docs/specs/a.md', 'turbo.json', '.buildd/env.yaml'] }),
    ).toEqual([]);
  });
});
