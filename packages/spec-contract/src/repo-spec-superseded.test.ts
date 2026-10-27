import { describe, expect, test } from 'bun:test';
import { crossCheckSpecs, markSpecSuperseded, parseSpecFrontmatter, type IndexedSpec } from './repo-spec';

const FILE = `---
title: Widget Exports
status: active
owner: someone
superseded_by: stale-value
summary: A widget export MUST write one file per widget.
domain: tasks
---
# Widget Exports

status: active is body text and stays.
- AC-1: GIVEN a widget WHEN exported THEN one file is written.
`;

describe('markSpecSuperseded (living-specs R-78)', () => {
  test('sets status and superseded_by in the frontmatter, and leaves the body byte for byte', () => {
    const out = markSpecSuperseded(FILE, 'widget-exports-v2')!;
    const { fm, body } = parseSpecFrontmatter(out);
    expect(fm).toMatchObject({ status: 'superseded', superseded_by: 'widget-exports-v2', title: 'Widget Exports', owner: 'someone' });
    expect(body).toBe(parseSpecFrontmatter(FILE).body);
    expect(out.match(/^superseded_by:/gm)).toHaveLength(1);
    expect(out.split('\n').indexOf('superseded_by: widget-exports-v2')).toBe(out.split('\n').indexOf('status: superseded') + 1);
  });

  test('adds a status line when there is none, and refuses a file with no frontmatter', () => {
    const out = markSpecSuperseded('---\ntitle: X\n---\n# X\n', 'none')!;
    expect(parseSpecFrontmatter(out).fm).toMatchObject({ status: 'superseded', superseded_by: 'none' });
    expect(markSpecSuperseded('# X\nno frontmatter\n', 'none')).toBeNull();
  });
});

describe('superseded_by names a repo slug, a native spec or nothing', () => {
  const s = (slug: string, superseded_by?: string): IndexedSpec => ({ file: `${slug}.md`, slug, fm: { title: slug, status: superseded_by ? 'superseded' : 'active', ...(superseded_by ? { superseded_by } : {}) } });

  test('`none` and `buildd:<short id>` need no file; an unknown slug is still an error', () => {
    expect(crossCheckSpecs([s('a', 'none'), s('b', 'buildd:0a1b2c3d'), s('c', 'a')])).toEqual([]);
    expect(crossCheckSpecs([s('a', 'missing-slug')])).toEqual(['a.md: superseded_by unknown spec "missing-slug"']);
    expect(crossCheckSpecs([s('a', 'buildd:not-hex')])).toHaveLength(1);
  });
});
