import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error plain .mjs with no declaration file
import { isRetryableNpmError, lockedVersion, pinnedPeerSpecs, satisfies } from './pinned-peers.mjs';

const LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "@ai-sdk/react": ["@ai-sdk/react@4.0.119", "", { "dependencies": {} }, "sha512-x"],
    "@builddai/ai-kit/react": ["react@19.1.0", "", {}, "sha512-nested"],
    "ai": ["ai@7.0.116", "", { "dependencies": {} }, "sha512-y"],
    "react": ["react@19.2.7", "", {}, "sha512-z"],
    "old": ["old@1.2.3", "", {}, "sha512-o"],
  }
}`;

describe('lockedVersion', () => {
  it('reads the hoisted version', () => {
    expect(lockedVersion(LOCK, 'ai')).toBe('7.0.116');
    expect(lockedVersion(LOCK, '@ai-sdk/react')).toBe('4.0.119');
  });

  it('prefers the copy nested under the kit', () => {
    expect(lockedVersion(LOCK, 'react')).toBe('19.1.0');
  });

  it('null when absent; a name is not matched as a prefix of another', () => {
    expect(lockedVersion(LOCK, 'react-dom')).toBeNull();
    expect(lockedVersion(LOCK, 'a')).toBeNull();
  });
});

describe('satisfies', () => {
  it('caret, tilde and exact', () => {
    expect(satisfies('7.0.116', '^7.0.0')).toBe(true);
    expect(satisfies('8.0.0', '^7.0.0')).toBe(false);
    expect(satisfies('6.9.9', '^7.0.0')).toBe(false);
    expect(satisfies('0.6.1', '^0.6.0')).toBe(true);
    expect(satisfies('0.7.0', '^0.6.0')).toBe(false);
    expect(satisfies('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfies('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfies('0.6.0', '0.6.0')).toBe(true);
    expect(satisfies('0.6.1', '0.6.0')).toBe(false);
  });

  it('a prerelease never satisfies; an unknown range shape is unknown', () => {
    expect(satisfies('7.1.0-beta.1', '^7.0.0')).toBe(false);
    expect(satisfies('7.0.0', '>=7 <8')).toBeNull();
  });
});

describe('pinnedPeerSpecs', () => {
  it('pins to bun.lock inside the range, and falls back to the range otherwise', () => {
    const specs = pinnedPeerSpecs({ ai: '^7.0.0', '@ai-sdk/react': '^4.0.0', 'react-dom': '^19.0.0', old: '^2.0.0' }, LOCK);
    expect(specs.map((s: { spec: string }) => s.spec)).toEqual([
      'ai@7.0.116',
      '@ai-sdk/react@4.0.119',
      'react-dom@^19.0.0',
      'old@^2.0.0',
    ]);
    expect(specs[2].note).toContain('not in bun.lock');
    expect(specs[3].note).toContain('outside ^2.0.0');
  });

  it('with no lockfile, every peer keeps its range', () => {
    expect(pinnedPeerSpecs({ ai: '^7.0.0' }, null).map((s: { spec: string }) => s.spec)).toEqual(['ai@^7.0.0']);
  });

  it("every peer the kit declares is pinned by the monorepo's own bun.lock", () => {
    const root = join(import.meta.dir, '..', '..', '..');
    const { peerDependencies } = JSON.parse(readFileSync(join(import.meta.dir, '..', 'package.json'), 'utf-8'));
    const specs = pinnedPeerSpecs(peerDependencies, readFileSync(join(root, 'bun.lock'), 'utf-8'));
    for (const s of specs) expect(s.note).toContain('(bun.lock');
  });
});

describe('isRetryableNpmError', () => {
  it('retries the registry and the network', () => {
    expect(isRetryableNpmError('npm error code ETARGET\nnpm error notarget No matching version found for ai@7.0.117.')).toBe(true);
    expect(isRetryableNpmError('npm error code ENOTFOUND\nnpm error syscall getaddrinfo')).toBe(true);
    expect(isRetryableNpmError('npm error code ECONNRESET')).toBe(true);
    expect(isRetryableNpmError('npm error network request to https://registry.npmjs.org/ai failed')).toBe(true);
  });

  it('does not retry a failure that would repeat', () => {
    expect(isRetryableNpmError('npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree')).toBe(false);
    expect(isRetryableNpmError('npm error code EINTEGRITY')).toBe(false);
  });
});
