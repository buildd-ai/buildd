import { describe, expect, it } from 'bun:test';
import { MAX_INFERRED_PATHS, inferPathsFromText } from '../task-path-inference';
import { extractExcerptPaths } from '../friction-manifest';

describe('inferPathsFromText', () => {
  it('finds the paths a real task description names', () => {
    expect(inferPathsFromText(
      'The `### Relevant to This Task` block in apps/runner/src/prompt-builder.ts is keyed on the title. See packages/core/memory-store.ts line 143.',
    )).toEqual(['apps/runner/src/prompt-builder.ts', 'packages/core/memory-store.ts']);
  });

  it('joins several parts, so a title and description are searched together', () => {
    expect(inferPathsFromText('Fix packages/core/db/schema.ts', 'and apps/web/src/lib/x.ts'))
      .toEqual(['packages/core/db/schema.ts', 'apps/web/src/lib/x.ts']);
  });

  it('accepts a directory with no extension under a known root', () => {
    expect(inferPathsFromText('Touches packages/core and docs/design')).toEqual(['packages/core', 'docs/design']);
  });

  it('makes an absolute path repo-relative', () => {
    expect(inferPathsFromText('Failed at /home/coder/project/buildd/apps/runner/src/index.ts:42'))
      .toEqual(['apps/runner/src/index.ts']);
  });

  it('strips the punctuation a path collects in a sentence', () => {
    expect(inferPathsFromText('Fix apps/web/src/lib/usage-drilldown.ts, then packages/core/db/schema.ts.'))
      .toEqual(['apps/web/src/lib/usage-drilldown.ts', 'packages/core/db/schema.ts']);
  });

  // English uses slashes constantly. Admitting bare two-segment fragments would
  // make the inference worse than no inference.
  it('does not match ordinary prose', () => {
    expect(inferPathsFromText('Decide read/write access and/or 9/10 of the cases')).toEqual([]);
    expect(inferPathsFromText('either/or, input/output, 24/7')).toEqual([]);
  });

  // A description linking a PR would otherwise retrieve memories about a
  // directory that does not exist.
  it('does not turn a URL into a path', () => {
    expect(inferPathsFromText('See https://github.com/buildd-ai/buildd/pull/2186 for context')).toEqual([]);
    expect(inferPathsFromText('docs at http://example.com/apps/web/src/x.ts')).toEqual([]);
  });

  // Regression: filtering AFTER the match failed here, because the absolute
  // alternative matches `/foo/bar.js` starting at the slash after the rejected
  // segment — so the extracted string no longer contained it.
  it('rejects generated output, including mid-path', () => {
    expect(inferPathsFromText('error in node_modules/foo/bar.js')).toEqual([]);
    expect(inferPathsFromText('.next/dev/types.ts blew up')).toEqual([]);
    expect(inferPathsFromText('see packages/core/dist/index.js')).toEqual([]);
  });

  it('de-duplicates and caps', () => {
    expect(inferPathsFromText('apps/a/x.ts apps/a/x.ts')).toEqual(['apps/a/x.ts']);
    const many = Array.from({ length: MAX_INFERRED_PATHS * 3 }, (_, i) => `apps/p${i}/x.ts`).join(' ');
    expect(inferPathsFromText(many)).toHaveLength(MAX_INFERRED_PATHS);
  });

  it('is safe on junk', () => {
    expect(inferPathsFromText()).toEqual([]);
    expect(inferPathsFromText(null, undefined, '')).toEqual([]);
    expect(inferPathsFromText('no paths here at all')).toEqual([]);
  });
});

/**
 * These two extractors must stay separate. `extractExcerptPaths` feeds
 * `tasks.path_manifest`, which drives path claims, inferred dependsOn edges and
 * the claim route's overlap gate — all of which treat the column as a
 * declaration by the task's author. This one is retrieval-only and permissive
 * enough to read prose, so sharing it would silently widen what those
 * serialisation gates act on.
 */
describe('kept separate from the path_manifest extractor', () => {
  it('is more permissive than the excerpt extractor, which is why it is separate', () => {
    const prose = 'Touches packages/core and docs/design';
    // The excerpt extractor requires an extension, so it finds nothing here...
    expect(extractExcerptPaths(prose)).toEqual([]);
    // ...while this one accepts the directories. That difference is the point:
    // extensionless directory guesses must not reach path_manifest.
    expect(inferPathsFromText(prose)).toEqual(['packages/core', 'docs/design']);
  });

  it('agrees with the excerpt extractor on an unambiguous file path', () => {
    const line = 'ENOENT at apps/runner/src/index.ts';
    expect(extractExcerptPaths(line)).toEqual(['apps/runner/src/index.ts']);
    expect(inferPathsFromText(line)).toEqual(['apps/runner/src/index.ts']);
  });
});
