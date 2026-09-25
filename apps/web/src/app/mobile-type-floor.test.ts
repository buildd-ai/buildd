/**
 * Mobile type floor: no text renders below 11px under the `md` breakpoint.
 *
 * Desktop keeps its 9–10px mono caption rhythm; phones get 11px. The pattern in
 * markup is `text-[11px] md:text-[10px]`, and in globals.css a single
 * `@media (width < 48rem)` block lifts every sub-11px component class.
 *
 * A bare (unprefixed) `text-[Npx]` with N < 11 applies at every width, so it is
 * the thing this test rejects. Exemptions are listed explicitly below.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '..');
const FLOOR = 11;

/**
 * Deliberate exemptions, as `path:substring-of-the-line`.
 * - Disclosure chevrons: the glyph is an icon, not text, and carries no label
 *   of its own (the button beside it does).
 */
const LINE_EXEMPT = [
  'app/app/(protected)/tasks/TaskGrid.tsx:transition-transform duration-150',
  'app/app/(protected)/missions/[id]/CondensedTimeline.tsx:text-[9px] transition-transform duration-200',
  'app/app/(protected)/missions/[id]/CondensedTimeline.tsx:text-[9px] rotate-90 inline-block">▶',
  'app/app/(protected)/missions/[id]/CondensedTimeline.tsx:<span className="text-[10px]">▶</span>',
  // Desktop-only: the sidebar rail is `hidden md:flex`, so these never render on a phone.
  'components/MissionsSidebar.tsx:min-w-[14px] h-3.5 px-0.5 text-[9px]',
  'components/TeamSwitcherRail.tsx:mt-0.5 mb-1 text-[7px]',
];

/**
 * Whole files owned by a parallel change (role editors ship their own mobile
 * pass). Remove the entry once that lands.
 */
const FILE_EXEMPT = [
  'app/app/(protected)/workspaces/[id]/skills/[skillId]/RoleEditor.tsx',
  'app/app/(protected)/team/[slug]/settings/TeamRoleEditor.tsx',
];

const BARE_PX = /(?<![:\w-])text-\[(\d+(?:\.\d+)?)px\]/g;

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const f of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
    if (/\.test\.tsx?$/.test(f) || f.includes('/__tests__/')) continue;
    out.push(f);
  }
  return out;
}

describe('mobile type floor (markup)', () => {
  it('has no bare sub-11px text-[Npx] classes outside the exemptions', () => {
    const violations: string[] = [];
    for (const rel of sourceFiles()) {
      if (FILE_EXEMPT.includes(rel)) continue;
      const lines = readFileSync(join(SRC, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(BARE_PX)) {
          if (Number(m[1]) >= FLOOR) continue;
          if (LINE_EXEMPT.some(e => e.startsWith(`${rel}:`) && line.includes(e.slice(rel.length + 1)))) continue;
          violations.push(`${rel}:${i + 1}: ${m[0]} — use text-[${FLOOR}px] md:${m[0]}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('every line exemption still matches a line (no stale entries)', () => {
    const stale = LINE_EXEMPT.filter(e => {
      const [rel, ...rest] = e.split(':');
      const needle = rest.join(':');
      try {
        return !readFileSync(join(SRC, rel), 'utf8').includes(needle);
      } catch {
        return true;
      }
    });
    expect(stale).toEqual([]);
  });

  it('the scan actually sees the md-prefixed pattern (guards an empty match set)', () => {
    const stage = readFileSync(join(SRC, 'components/StageChip.tsx'), 'utf8');
    expect(stage).toContain('text-[11px] md:text-[10px]');
    expect(sourceFiles().length).toBeGreaterThan(100);
  });
});

describe('mobile type floor (globals.css)', () => {
  const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

  function mobileFloorBlock(): string {
    const start = css.indexOf('@media (width < 48rem)');
    if (start === -1) throw new Error('mobile floor @media block not found in globals.css');
    return css.slice(start, css.indexOf('}', css.indexOf('{', start) + 1) + 1);
  }

  it('lifts every sub-11px component class to 11px below md', () => {
    const small = new Set<string>();
    for (const m of css.matchAll(/\.([a-z][\w-]*)\s*\{[^}]*?font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      if (Number(m[2]) < FLOOR) small.add(m[1]);
    }
    expect(small.size).toBeGreaterThan(0);
    const block = mobileFloorBlock();
    expect(block).toContain(`font-size: ${FLOOR}px`);
    const missing = [...small].filter(cls => !new RegExp(`\\.${cls}\\b`).test(block));
    expect(missing).toEqual([]);
  });

  it('includes the section label and pills named in the mobile QA pass', () => {
    const block = mobileFloorBlock();
    for (const cls of ['section-label-missions', 'status-pill', 'health-pill', 'field-label', 'type-label']) {
      expect(block).toContain(`.${cls}`);
    }
  });
});
