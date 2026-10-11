import { describe, test, expect } from 'bun:test';
import { detectDerivedFiles } from '../derived-files-detect';

describe('detectDerivedFiles', () => {
  test('a root lockfile is anchored to the root and regenerated there', () => {
    expect(detectDerivedFiles(['package.json', 'bun.lock', 'src/a.ts'])).toEqual([
      { glob: '/bun.lock', regenerate: 'bun install' },
    ]);
  });

  test('a nested lockfile regenerates from its own directory', () => {
    expect(detectDerivedFiles(['tools/cli/Cargo.toml', 'tools/cli/Cargo.lock'])).toEqual([
      { glob: 'tools/cli/Cargo.lock', regenerate: "cd 'tools/cli' && cargo update --workspace" },
    ]);
  });

  test('covers the common ecosystems, lockfile-only where the tool allows it', () => {
    const rules = detectDerivedFiles([
      'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'poetry.lock', 'uv.lock', 'go.sum', 'Gemfile.lock',
    ]);
    expect(rules.map(r => r.regenerate)).toEqual([
      'npm install --package-lock-only',
      'pnpm install --lockfile-only',
      'yarn install',
      'poetry lock',
      'uv lock',
      'go mod tidy',
      'bundle lock',
    ]);
  });

  test('ignores vendored and dependency trees, and anything that is not a lockfile', () => {
    expect(detectDerivedFiles([
      'node_modules/x/package-lock.json',
      'vendor/foo/go.sum',
      'packages/core/drizzle/meta/_journal.json',
      'README.md',
    ])).toEqual([]);
  });

  test('never proposes a path containing a quote', () => {
    expect(detectDerivedFiles(["we'ird/bun.lock"])).toEqual([]);
  });
});
