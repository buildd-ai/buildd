/**
 * The pure parts of the spec pages (living-specs.md §9): where a spec stands in
 * words, the parent/child tree, and links to a cited repo file at its commit.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/specs/page-view.test.ts
 */
import { describe, expect, it } from 'bun:test';
import { ago, repoRefHref, specStanding, specTree } from './page-view';

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id, workspaceId: 'w', title: id, scope: 'feature', parentSpecId: null, status: 'draft', version: 1,
  bodyArtifactId: 'a', headRevision: 1, approvedRevision: null, createdBy: null,
  createdAt: new Date('2026-10-01T00:00:00Z'), updatedAt: new Date('2026-10-02T00:00:00Z'), ...over,
}) as any;

describe('specStanding', () => {
  it('names the approved revision and the newer one waiting', () => {
    expect(specStanding({ status: 'draft', approvedRevision: 1, headRevision: 2 })).toEqual({ standing: 'approved at revision 1', waiting: 2 });
    expect(specStanding({ status: 'approved', approvedRevision: 3, headRevision: 3 })).toEqual({ standing: 'approved at revision 3', waiting: null });
  });
  it('says a spec was never approved, and retired or superseded wins', () => {
    expect(specStanding({ status: 'in_review', approvedRevision: null, headRevision: 2 })).toEqual({ standing: 'draft, never approved', waiting: null });
    expect(specStanding({ status: 'retired', approvedRevision: 2, headRevision: 3 })).toEqual({ standing: 'retired', waiting: null });
    expect(specStanding({ status: 'superseded', approvedRevision: 1, headRevision: 1 })).toEqual({ standing: 'superseded', waiting: null });
  });
});

describe('specTree', () => {
  it('puts a child under its parent and keeps order within a level', () => {
    const tree = specTree([
      row('child', { parentSpecId: 'parent' }),
      row('parent', { approvedRevision: 1, headRevision: 2 }),
      row('lone'),
    ]);
    expect(tree.map((n) => n.id)).toEqual(['parent', 'lone']);
    expect(tree[0].children.map((n) => n.id)).toEqual(['child']);
    expect(tree[0]).toMatchObject({ standing: 'approved at revision 1', waiting: 2 });
    expect(tree[1]).toMatchObject({ standing: 'draft, never approved', waiting: null });
  });
  it('puts a spec whose parent is not listed at the top', () => {
    expect(specTree([row('orphan', { parentSpecId: 'elsewhere' })]).map((n) => n.id)).toEqual(['orphan']);
  });
});

describe('repoRefHref', () => {
  const ref = { path: 'docs/specs/x y.md', commitSha: 'a'.repeat(40) };
  it('links the file at the cited commit', () => {
    expect(repoRefHref('acme/app', ref)).toBe(`https://github.com/acme/app/blob/${'a'.repeat(40)}/docs/specs/x%20y.md`);
  });
  it('is plain text without a linked repo', () => {
    expect(repoRefHref(null, ref)).toBeNull();
  });
});

describe('ago', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  it('says how long ago in words', () => {
    expect(ago('2026-10-11T11:59:40Z', now)).toBe('just now');
    expect(ago('2026-10-11T11:15:00Z', now)).toBe('45m ago');
    expect(ago('2026-10-11T07:00:00Z', now)).toBe('5h ago');
    expect(ago('2026-10-08T12:00:00Z', now)).toBe('3d ago');
  });
});
