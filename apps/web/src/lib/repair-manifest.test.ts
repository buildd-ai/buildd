import { describe, it, expect } from 'bun:test';
import { repairPathManifest, readRepairPrFiles, REPAIR_MANIFEST_MAX_FILES } from './repair-manifest';
import { declaresNoScope } from '@buildd/core/path-overlap';
import { advisoryMutexApplies, advisoryBlockingPeer } from '@/app/api/workers/claim/coordination-gates';

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

  it('is claimable beside an in-flight scope-undeclared task (advisory_manifest gate)', () => {
    const repair = { category: null, outputRequirement: 'auto', pathManifest: repairPathManifest(['**'], ['a.ts']) };
    expect(declaresNoScope(repair.pathManifest)).toBe(false);
    expect(advisoryMutexApplies(repair)).toBe(false);
    // Today's inherited sentinel is gated behind the in-flight undeclared peer.
    const old = { ...repair, pathManifest: ['**'] };
    expect(advisoryMutexApplies(old)).toBe(true);
    expect(advisoryBlockingPeer('repair', new Set(['peer']))).toBe('peer');
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
