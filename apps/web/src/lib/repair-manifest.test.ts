import { describe, it, expect } from 'bun:test';
import { repairPathManifest, readRepairPrFiles, REPAIR_MANIFEST_MAX_FILES } from './repair-manifest';
import { declaresNoScope } from '@buildd/core/path-overlap';

describe('repairPathManifest', () => {
  it('replaces a repo-wide owner scope with the PR files', () => {
    expect(repairPathManifest(['**'], ['a.ts', 'b/c.ts'])).toEqual(['a.ts', 'b/c.ts']);
  });
  it('unions the owner concrete entries with the PR files', () => {
    expect(repairPathManifest(['x/', 'a.ts'], ['a.ts', 'b.ts'])).toEqual(['x', 'a.ts', 'b.ts']);
  });
  it('falls back to the owner manifest when the PR files are unknown', () => {
    expect(repairPathManifest(['a.ts'], null)).toEqual(['a.ts']);
  });
  it('keeps today behaviour when the owner has no scope and files are unknown', () => {
    expect(repairPathManifest(['**'], null)).toEqual(['**']);
    expect(repairPathManifest(null, null)).toBeNull();
    expect(repairPathManifest([], [])).toEqual([]);
  });
  it('ignores a PR file list too large to be a useful scope', () => {
    const many = Array.from({ length: REPAIR_MANIFEST_MAX_FILES + 1 }, (_, i) => `f${i}.ts`);
    expect(repairPathManifest(['**'], many)).toEqual(['**']);
  });

  it('gives a repair of a repo-wide owner a concrete scope (precision for the overlap policy)', () => {
    expect(declaresNoScope(repairPathManifest(['**'], ['a.ts']))).toBe(false);
  });
});

describe('readRepairPrFiles', () => {
  const pr = (sha: string) => ({ state: 'open', head: { sha }, base: { sha: 'b', ref: 'dev' }, changed_files: 1 });
  it('returns the changed files of a complete read', async () => {
    const get = async (p: string) => (p.includes('/files') ? [{ filename: 'a.ts' }] : pr('h1'));
    expect(await readRepairPrFiles(get, { repoFullName: 'o/r', prNumber: 1, headSha: 'h1' })).toEqual(['a.ts']);
  });
  it('returns null when the read is not usable', async () => {
    const get = async () => { throw new Error('boom'); };
    expect(await readRepairPrFiles(get, { repoFullName: 'o/r', prNumber: 1 })).toBeNull();
  });
});
