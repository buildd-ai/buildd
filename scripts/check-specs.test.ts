import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { claimedSymbols, codeSurfacePaths, resolveSymbols, VERIFIED_BY_DEBT } from './check-specs';

/**
 * Guards for the two checks that make `specs:lint` test whether a spec is TRUE
 * rather than merely well-formed: symbol liveness and the `verified_by` ratchet.
 *
 * Written because the checks themselves assert that an unguarded contract is not
 * a contract. Shipping them unguarded would have been the same defect one level up.
 */

const SPECS_DIR = join(import.meta.dir, '..', 'docs/specs');
const META = new Set(['SPEC-FORMAT.md', 'REPORT.md', 'INDEX.md']);

function specSlugs(): string[] {
  return readdirSync(SPECS_DIR)
    .filter((f) => f.endsWith('.md') && !META.has(f))
    .map((f) => f.replace(/\.md$/, ''));
}

function frontmatterOf(slug: string): string {
  const raw = readFileSync(join(SPECS_DIR, `${slug}.md`), 'utf8');
  const end = raw.indexOf('\n---', 3);
  return end === -1 ? '' : raw.slice(3, end);
}

describe('claimedSymbols', () => {
  test('claims camelCase with an internal hump', () => {
    expect(claimedSymbols('the guard `isCleanupExpiry` runs first')).toEqual(['isCleanupExpiry']);
  });

  test('claims SCREAMING_SNAKE constants', () => {
    expect(claimedSymbols('past `QUEUE_STALL_THRESHOLD` it alerts')).toEqual([
      'QUEUE_STALL_THRESHOLD',
    ]);
  });

  test('strips a trailing call form', () => {
    expect(claimedSymbols('`derivePolicy()` returns')).toEqual(['derivePolicy']);
  });

  test('ignores paths, prose, and dotted expressions — codeSurfacePaths owns paths', () => {
    const body = 'see `apps/runner/src/workers.ts`, `resultMeta.cbm`, and `a real sentence`';
    expect(claimedSymbols(body)).toEqual([]);
  });

  test('ignores PascalCase and snake_case: mostly library types and third-party tool names', () => {
    // `NextRequest` is imported, `index_repository` is a CBM tool — neither is ours
    // to guarantee, and including them produced the only false positives observed.
    expect(claimedSymbols('`NextRequest` calls `index_repository`')).toEqual([]);
  });

  test('deduplicates repeated claims', () => {
    expect(claimedSymbols('`buildCbmActivation` … `buildCbmActivation`')).toEqual([
      'buildCbmActivation',
    ]);
  });
});

describe('resolveSymbols', () => {
  test('a symbol that exists in the source tree is not reported dead', () => {
    expect([...resolveSymbols(['buildCbmActivation'])]).toEqual([]);
  });

  test('a symbol that exists nowhere is reported dead', () => {
    expect([...resolveSymbols(['zzzNotARealSymbolInThisRepo'])]).toEqual([
      'zzzNotARealSymbolInThisRepo',
    ]);
  });

  test('a symbol that exists ONLY under docs/ is reported dead', () => {
    // `buildWorkerMountAllowlist` is named by three design docs and never shipped;
    // the code exports `buildWorkerBwrapArgv`. A spec citing the design's name is
    // exactly the drift this check exists to catch, so docs must not satisfy it.
    expect([...resolveSymbols(['buildWorkerMountAllowlist'])]).toEqual([
      'buildWorkerMountAllowlist',
    ]);
  });

  test('resolves a mixed batch in one pass', () => {
    const dead = resolveSymbols(['buildCbmActivation', 'zzzAlsoNotReal', 'CBM_BINARY_PATH']);
    expect([...dead]).toEqual(['zzzAlsoNotReal']);
  });

  test('an empty claim set does no work', () => {
    expect(resolveSymbols([]).size).toBe(0);
  });
});

describe('verified_by ratchet', () => {
  test('every slug on the debt list is a real spec', () => {
    const slugs = new Set(specSlugs());
    const stale = [...VERIFIED_BY_DEBT].filter((slug) => !slugs.has(slug));
    expect(stale, 'debt list names specs that no longer exist — prune it').toEqual([]);
  });

  test('a spec that has gained guards is off the debt list', () => {
    // The ratchet only shrinks. Leaving a slug here after its tests exist means
    // the warning keeps firing and the count stops meaning anything.
    const paidOff = [...VERIFIED_BY_DEBT].filter((slug) => {
      const match = /^verified_by:\s*\[(.*)\]/m.exec(frontmatterOf(slug));
      return !!match && match[1].trim().length > 0;
    });
    expect(paidOff, 'these specs now name guards — remove them from VERIFIED_BY_DEBT').toEqual([]);
  });

  test('no new spec joins the debt list', () => {
    // 19 pre-existing specs owed guards when the check landed on 2026-08-30, and
    // mcp-action-contracts paid its debt off with the on-demand-review guards.
    // The number is asserted so growing it requires editing this test and
    // explaining why.
    expect(VERIFIED_BY_DEBT.size).toBeLessThanOrEqual(18);
  });
});

describe('codeSurfacePaths', () => {
  // A multi-section spec repeats the `Code surface` label per section. Reading only
  // the first match left sections 2..N unchecked, so a dead path in a later section
  // passed the linter — work-tracker-integration.md had three sections and its §3
  // named a route that does not exist, while specs:lint reported 0 errors.
  test('collects paths from every Code surface section, not just the first', () => {
    const body = [
      '## 1. First capability',
      '**Code surface**: `apps/web/src/one.ts`',
      '',
      '## 2. Second capability',
      '**Code surface**: `apps/web/src/two.ts`',
      '',
      '## 3. Third capability',
      '**Code surface**: `apps/web/src/three.ts`',
    ].join('\n');

    expect(codeSurfacePaths(body).sort()).toEqual([
      'apps/web/src/one.ts',
      'apps/web/src/three.ts',
      'apps/web/src/two.ts',
    ]);
  });

  test('handles the three label spellings within one body', () => {
    const body = [
      '**Code surface**: `apps/a.ts`',
      '',
      '## Code surface',
      '`packages/b.ts`',
      '',
      '**Other label**: not a surface',
      '',
      'Code surface: `scripts/c.ts`',
    ].join('\n');

    expect(codeSurfacePaths(body).sort()).toEqual(['apps/a.ts', 'packages/b.ts', 'scripts/c.ts']);
  });

  test('still stops at the next label so neighbouring prose is not scanned', () => {
    const body = [
      '**Code surface**: `apps/web/src/real.ts`',
      '',
      '**Invariants**: `apps/web/src/not-a-surface.ts` is only mentioned',
    ].join('\n');

    expect(codeSurfacePaths(body)).toEqual(['apps/web/src/real.ts']);
  });

  test('returns nothing when a body has no Code surface section', () => {
    expect(codeSurfacePaths('## Overview\nJust prose about `apps/web/src/x.ts`.')).toEqual([]);
  });
});
