import { describe, it, expect } from 'bun:test';
import {
  pathsOverlap,
  findBlockingPr,
  isAdvisoryManifest,
  declaresNoScope,
  shouldSerializeByManifest,
} from '../path-overlap';

describe('pathsOverlap', () => {
  it('returns false for empty arrays', () => {
    expect(pathsOverlap([], ['a.ts'])).toBe(false);
    expect(pathsOverlap(['a.ts'], [])).toBe(false);
    expect(pathsOverlap([], [])).toBe(false);
  });

  it('detects exact path matches', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);
  });

  it('returns false for non-overlapping files', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib/bar.ts'],
    )).toBe(false);
  });

  it('detects overlap when one path is a prefix (directory) of the other', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);

    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src'],
    )).toBe(true);
  });

  it('does not false-positive on similar directory names', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib-extra/foo.ts'],
      ['apps/web/src/lib'],
    )).toBe(false);
  });

  it('strips trailing slashes before comparing', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);
  });

  it('handles many-to-many overlap: only one pair needs to match', () => {
    expect(pathsOverlap(
      ['a.ts', 'b.ts', 'apps/web/src/lib/mcp-oauth.ts'],
      ['c.ts', 'd.ts', 'apps/web/src/lib/mcp-oauth.ts'],
    )).toBe(true);
  });

  it('returns false when lists share no files', () => {
    expect(pathsOverlap(
      ['apps/web/src/lib/foo.ts', 'apps/web/src/lib/bar.ts'],
      ['apps/runner/index.ts', 'packages/core/db/schema.ts'],
    )).toBe(false);
  });

  it('returns true when either manifest contains the repo-wide wildcard sentinel "**"', () => {
    expect(pathsOverlap(['**'], ['apps/web/src/lib/foo.ts'])).toBe(true);
    expect(pathsOverlap(['apps/web/src/lib/foo.ts'], ['**'])).toBe(true);
    expect(pathsOverlap(['**'], ['**'])).toBe(true);
    expect(pathsOverlap(['apps/web/src/lib/foo.ts', '**'], ['packages/core/db/schema.ts'])).toBe(true);
  });

  it('still returns false for empty arrays even when combined with "**" elsewhere', () => {
    expect(pathsOverlap([], ['**'])).toBe(false);
    expect(pathsOverlap(['**'], [])).toBe(false);
  });
});

describe('findBlockingPr', () => {
  it('returns null when candidate has no manifest', () => {
    const result = findBlockingPr([], [
      { pathManifest: ['foo.ts'], prNumber: 1, prUrl: 'https://github.com/org/repo/pull/1' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when no open PR overlaps', () => {
    const result = findBlockingPr(['apps/web/src/lib/foo.ts'], [
      { pathManifest: ['apps/web/src/lib/bar.ts'], prNumber: 42, prUrl: 'https://github.com/org/repo/pull/42' },
    ]);
    expect(result).toBeNull();
  });

  it('returns the blocking PR info when an open PR overlaps', () => {
    const result = findBlockingPr(
      ['apps/web/src/lib/mcp-oauth.ts'],
      [
        { pathManifest: ['apps/web/src/lib/bar.ts'], prNumber: 1, prUrl: 'url1' },
        { pathManifest: ['apps/web/src/lib/mcp-oauth.ts'], prNumber: 1126, prUrl: 'url1126' },
      ],
    );
    expect(result).toEqual({ prNumber: 1126, prUrl: 'url1126' });
  });

  it('returns null when open PR tasks have no pathManifest', () => {
    const result = findBlockingPr(['foo.ts'], [
      { pathManifest: null, prNumber: 1, prUrl: 'url' },
      { pathManifest: [], prNumber: 2, prUrl: 'url2' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when candidate manifest is ["**"] (advisory-only)', () => {
    // A task with "**" hasn't declared specific scope — should not be blocked.
    const result = findBlockingPr(['**'], [
      { pathManifest: ['packages/core/schema.ts'], prNumber: 42, prUrl: 'url42' },
    ]);
    expect(result).toBeNull();
  });

  it('returns null when a sibling PR task manifest is ["**"] (advisory-only)', () => {
    // A sibling with "**" hasn't declared specific scope — should not block others.
    const result = findBlockingPr(
      ['packages/core/schema.ts'],
      [{ pathManifest: ['**'], prNumber: 99, prUrl: 'url99' }],
    );
    expect(result).toBeNull();
  });

  it('blocks on a real overlap even when wildcard siblings are present', () => {
    // Wildcard sibling is skipped, but a specific-overlap sibling still blocks.
    const result = findBlockingPr(
      ['src/foo.ts'],
      [
        { pathManifest: ['**'], prNumber: 1, prUrl: 'url1' },  // skipped (wildcard)
        { pathManifest: ['src/foo.ts'], prNumber: 2, prUrl: 'url2' }, // blocks
      ],
    );
    expect(result).toEqual({ prNumber: 2, prUrl: 'url2' });
  });
});


// ── Advisory-wildcard predicates (authoring-time edge rule) ──────────────────
// Regression guard for the "dependency costume" bug: mission tasks filed without
// a pathManifest default to ['**'], pathsOverlap() treats '**' as overlapping
// everything, and the authoring pass therefore stored a hard dependsOn edge to
// every in-flight task in the workspace — while the claim-time gates
// (findBlockingPr, path_claims layer 2) explicitly ignore '**' as advisory.

describe('isAdvisoryManifest', () => {
  it('is true for the bare repo-wide sentinel', () => {
    expect(isAdvisoryManifest(['**'])).toBe(true);
  });

  it('is true when the sentinel appears alongside concrete paths', () => {
    // A manifest extended by check_path_claim keeps its original '**' entry.
    expect(isAdvisoryManifest(['**', 'apps/web/src/lib/foo.ts'])).toBe(true);
  });

  it('is false for concrete manifests', () => {
    expect(isAdvisoryManifest(['apps/web/src/lib/foo.ts'])).toBe(false);
    expect(isAdvisoryManifest(['apps/web/src/lib'])).toBe(false);
  });

  it('is false for null / undefined / empty manifests', () => {
    expect(isAdvisoryManifest(null)).toBe(false);
    expect(isAdvisoryManifest(undefined)).toBe(false);
    expect(isAdvisoryManifest([])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// declaresNoScope — the SUPERSET predicate used by the claim loop's
// advisory-manifest serialization guard.
//
// `isAdvisoryManifest` answers "does this manifest carry the sentinel?", which
// is the right question for the callers that must NOT change behaviour for a
// missing manifest (findBlockingPr / shouldSerializeByManifest bail on empty
// with "nothing to compare"; the path-claim + MCP routes reject a wildcard with
// a wildcard-specific message; reviewer.ts renders a sentinel-specific section).
//
// The serialization guard asks a different question: "did this task declare a
// scope at all?" A task with NO manifest — pre-dating the ['**'] mission default,
// or created through any path that skips it — is just as undeclared as one
// carrying the sentinel, and two of them in one mission collide on the same
// files. isAdvisoryManifest(null) === false let exactly that through.
// ─────────────────────────────────────────────────────────────────────────────

describe('declaresNoScope', () => {
  it('is true for the repo-wide sentinel (superset of isAdvisoryManifest)', () => {
    expect(declaresNoScope(['**'])).toBe(true);
    expect(declaresNoScope(['**', 'apps/web/src/lib/foo.ts'])).toBe(true);
  });

  it('is true for a null / undefined manifest — the front-door gap', () => {
    expect(declaresNoScope(null)).toBe(true);
    expect(declaresNoScope(undefined)).toBe(true);
  });

  it('is true for an empty manifest', () => {
    expect(declaresNoScope([])).toBe(true);
  });

  it('is false for concrete manifests', () => {
    expect(declaresNoScope(['apps/web/src/lib/foo.ts'])).toBe(false);
    expect(declaresNoScope(['apps/web/src/lib'])).toBe(false);
    expect(declaresNoScope(['a.ts', 'b.ts'])).toBe(false);
  });

  it('is implied by isAdvisoryManifest for every manifest shape', () => {
    // A one-way implication, deliberately: advisory ⇒ no declared scope, but
    // not the reverse. If this ever inverts, the two predicates have been
    // conflated and the null-manifest gap is back.
    const shapes: Array<string[] | null | undefined> = [
      null, undefined, [], ['**'], ['**', 'a.ts'], ['a.ts'], ['apps/web'],
    ];
    for (const m of shapes) {
      if (isAdvisoryManifest(m)) expect(declaresNoScope(m)).toBe(true);
    }
    // And strictly wider: at least one shape differs.
    expect(shapes.some(m => declaresNoScope(m) && !isAdvisoryManifest(m))).toBe(true);
  });
});

describe('shouldSerializeByManifest', () => {
  it('serializes two concrete manifests that share an exact path', () => {
    expect(shouldSerializeByManifest(
      ['apps/web/src/lib/mcp-oauth.ts'],
      ['apps/web/src/lib/mcp-oauth.ts'],
    )).toBe(true);
  });

  it('serializes two concrete manifests that overlap by directory prefix', () => {
    expect(shouldSerializeByManifest(
      ['apps/web/src/lib'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(true);
  });

  it('does not serialize non-overlapping concrete manifests', () => {
    expect(shouldSerializeByManifest(
      ['apps/web/src/lib/foo.ts'],
      ['packages/core/db/schema.ts'],
    )).toBe(false);
  });

  it('does not serialize when the candidate manifest is wildcard-scoped', () => {
    expect(shouldSerializeByManifest(['**'], ['packages/core/db/schema.ts'])).toBe(false);
  });

  it('does not serialize when the sibling manifest is wildcard-scoped', () => {
    expect(shouldSerializeByManifest(['packages/core/db/schema.ts'], ['**'])).toBe(false);
  });

  it('does not serialize two wildcard-scoped manifests against each other', () => {
    expect(shouldSerializeByManifest(['**'], ['**'])).toBe(false);
  });

  it('does not serialize when a wildcard rides along with a genuinely overlapping path', () => {
    // The concrete overlap is real, but the '**' entry means this task never
    // declared its scope — the claim-time gate ignores it, so authoring must too.
    expect(shouldSerializeByManifest(
      ['**', 'apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib/foo.ts'],
    )).toBe(false);
  });

  it('does not serialize empty manifests', () => {
    expect(shouldSerializeByManifest([], ['foo.ts'])).toBe(false);
    expect(shouldSerializeByManifest(['foo.ts'], [])).toBe(false);
    expect(shouldSerializeByManifest(null, ['foo.ts'])).toBe(false);
    expect(shouldSerializeByManifest(['foo.ts'], undefined)).toBe(false);
  });

  it('agrees with findBlockingPr for every manifest pair (authoring rule == runtime rule)', () => {
    // The authoring-time edge rule and the claim-time block rule must be the
    // same predicate, not two similar-looking ones. If this ever diverges, a
    // stored edge can outlive (or contradict) the runtime gate again.
    const manifests: Array<string[]> = [
      ['apps/web/src/lib/foo.ts'],
      ['apps/web/src/lib'],
      ['apps/web/src/lib/bar.ts'],
      ['packages/core/db/schema.ts'],
      ['**'],
      ['**', 'apps/web/src/lib/foo.ts'],
    ];

    for (const a of manifests) {
      for (const b of manifests) {
        const authoring = shouldSerializeByManifest(a, b);
        const runtime = findBlockingPr(a, [{ pathManifest: b, prNumber: 1, prUrl: 'url1' }]) !== null;
        expect(`${a.join('|')} vs ${b.join('|')} => ${authoring}`)
          .toBe(`${a.join('|')} vs ${b.join('|')} => ${runtime}`);
      }
    }
  });
});
