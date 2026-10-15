import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { repoSpecForImport } from './repo-import';
import { renderRepoCopy, verifyRepoCopy } from './repo-copy';
import { parseSpecFrontmatter } from './repo-spec';

const FILE = `---
title: Widget Exports
status: active
owner: someone
last_verified: 2026-10-01
summary: A widget export MUST write one file per widget.
domain: knowledge
surfaces: [apps/web/src/lib/widget.ts]
related: [release-flow]
keywords: [widget, export]
verified_by: [apps/web/src/lib/widget.test.ts, apps/web/tests/db/widget.test.ts]
supersedes: []
assertions:
  - id: widget-route
    skip_until: "2026-12-15"
    type: route
    method: GET
  - id: widget-symbol
    type: symbol
    name: exportWidget
---
# Widget Exports

- AC-1: GIVEN a widget WHEN exported THEN one file is written.
`;

describe('repoSpecForImport (R-18): the file minus its frontmatter', () => {
  it('drops the frontmatter block from the body, keeps the text after it byte for byte, and lifts the mechanical fields and the summary into the metadata block', () => {
    const r = repoSpecForImport('docs/specs/widget-exports.md', FILE);
    if (!r.ok) throw new Error(r.message);
    expect(r.title).toBe('Widget Exports');
    expect(r.domain).toBe('knowledge');
    expect(r.status).toBe('active');
    expect(r.unread).toEqual([]);
    expect(r.body).toBe(`# Widget Exports

- AC-1: GIVEN a widget WHEN exported THEN one file is written.
`);
    expect(r.metadata).toEqual({
      owner: 'someone',
      summary: 'A widget export MUST write one file per widget.',
      last_verified: '2026-10-01',
      surfaces: ['apps/web/src/lib/widget.ts'],
      verified_by: ['apps/web/src/lib/widget.test.ts', 'apps/web/tests/db/widget.test.ts'],
      assertions: [
        { id: 'widget-route', skip_until: '2026-12-15', type: 'route', method: 'GET' },
        { id: 'widget-symbol', type: 'symbol', name: 'exportWidget' },
      ],
    });
  });

  it('renders as a generated copy that carries the same intent and the same metadata (a confirmed import round-trips)', async () => {
    const r = repoSpecForImport('docs/specs/widget-exports.md', FILE);
    if (!r.ok) throw new Error(r.message);
    const copy = await renderRepoCopy({ shortId: 'abcd1234', revision: 1, title: r.title, body: r.body, metadata: r.metadata, domain: 'knowledge', status: 'active', defaultOwner: 'buildd', defaultLastVerified: '2026-10-13' });
    if (!copy.ok) throw new Error(copy.message);
    const v = await verifyRepoCopy(copy.text);
    expect(v.generated && v.ok).toBe(true);
    const { fm } = parseSpecFrontmatter(copy.text);
    expect(fm?.title).toBe('Widget Exports');
    expect(fm?.summary).toBe('A widget export MUST write one file per widget.');
    expect(fm?.owner).toBe('someone');
    expect(fm?.domain).toBe('knowledge');
    expect(fm?.verified_by).toEqual(['apps/web/src/lib/widget.test.ts', 'apps/web/tests/db/widget.test.ts']);
  });

  it('skips the meta files, superseded specs and generated copies, each with a reason (R-20)', () => {
    expect(repoSpecForImport('docs/specs/SPEC-FORMAT.md', FILE)).toMatchObject({ ok: false, reason: 'meta_file' });
    expect(repoSpecForImport('docs/specs/INDEX.md', '# Spec Index\n')).toMatchObject({ ok: false, reason: 'meta_file' });
    expect(repoSpecForImport('docs/SPEC.md', FILE)).toMatchObject({ ok: false, reason: 'not_a_spec_file' });
    expect(repoSpecForImport('docs/specs/old.md', FILE.replace('status: active', 'status: superseded\nsuperseded_by: widget-exports'))).toMatchObject({ ok: false, reason: 'superseded' });
    expect(repoSpecForImport('docs/specs/gen.md', FILE.replace('supersedes: []', 'supersedes: []\ngenerated_from: abcd1234@r1'))).toMatchObject({ ok: false, reason: 'generated_copy' });
    expect(repoSpecForImport('docs/specs/blank.md', 'no title here\n')).toMatchObject({ ok: false, reason: 'no_title' });
  });

  it('a file with only mechanical frontmatter imports with no frontmatter, titled by its heading', () => {
    const r = repoSpecForImport('docs/specs/bare.md', '---\nstatus: draft\ndomain: ops\n---\n# Bare Spec\n\nR-1: x\n');
    if (!r.ok) throw new Error(r.message);
    expect(r.body).toBe('# Bare Spec\n\nR-1: x\n');
    expect(r.title).toBe('Bare Spec');
    expect(r.domain).toBe('ops');
  });

  it('every spec in this repo either imports to a body with no mechanical field left, or is skipped with a reason', () => {
    const dir = join(import.meta.dir, '../../../docs/specs');
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const r = repoSpecForImport(`docs/specs/${name}`, readFileSync(join(dir, name), 'utf8'));
      if (!r.ok) { expect(r.message.length).toBeGreaterThan(0); continue; }
      const { fm } = parseSpecFrontmatter(r.body);
      for (const k of ['status', 'owner', 'last_verified', 'domain', 'surfaces', 'verified_by', 'assertions']) expect(fm && k in fm).toBeFalsy();
      expect(r.body.startsWith('---\n')).toBe(false);
      expect(r.body).not.toContain('# Structural conformance');
      expect(r.unread).toEqual([]);
    }
  });

  it('drops a YAML comment in the frontmatter, so it never becomes the first heading of the body', () => {
    const file = '---\ntitle: Commented\nstatus: active\n# Structural conformance only; passing does not certify every prose invariant.\nassertions:\n  - id: a\n    type: symbol\n    name: thing\n---\n# Commented\n\nR-1: x\n';
    const r = repoSpecForImport('docs/specs/commented.md', file);
    if (!r.ok) throw new Error(r.message);
    expect(r.body).toBe('# Commented\n\nR-1: x\n');
    expect(r.metadata.assertions).toEqual([{ id: 'a', type: 'symbol', name: 'thing' }]);
  });

  it('reports the criterion ids it could not read and the ids defined twice, and records them on the metadata', () => {
    const file = '---\ntitle: Messy\nstatus: draft\n---\n# Messy\n\n- AC-1: one\n- AC-3a: suffixed\n- AC-AQR-1: prefixed\n- INV-1: invariant\n- AC-1: again\n';
    const r = repoSpecForImport('docs/specs/messy.md', file);
    if (!r.ok) throw new Error(r.message);
    const expected = {
      unreadable: [{ id: 'AC-3a', line: 4 }, { id: 'AC-AQR-1', line: 5 }, { id: 'INV-1', line: 6 }],
      duplicates: [{ id: 'AC-1', lines: [3, 7] }],
    };
    expect(r.criteria).toEqual(expected);
    expect(r.metadata.criteria_unread).toEqual(expected);
  });

  it('a body with clean criteria records nothing about them', () => {
    const r = repoSpecForImport('docs/specs/widget-exports.md', FILE);
    if (!r.ok) throw new Error(r.message);
    expect(r.criteria).toEqual({ unreadable: [], duplicates: [] });
    expect('criteria_unread' in r.metadata).toBe(false);
  });
});
