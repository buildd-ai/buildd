/**
 * Mobile type floor: no text renders below 11px under the `md` breakpoint.
 *
 * Desktop keeps its 9-10px mono caption rhythm; phones get 11px. The pattern in
 * markup is `text-[11px] md:text-[10px]`, and in globals.css a single
 * `@media (width < 48rem)` block lifts every sub-11px component class.
 *
 * A `text-[Npx]` with N < 11 is a violation unless its variant chain contains a
 * min-width breakpoint of md or wider (`md:`, `lg:`, `xl:`, `2xl:`). Anything
 * else — bare, `sm:`, `max-md:`, `dark:`, `hover:` — can apply on a phone.
 * Exemptions are listed explicitly below, each pinned to one token.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '..');
const FLOOR = 11;

/**
 * Deliberate exemptions. `context` must START with the exempt token and is
 * matched in the line; only the token at that exact position is exempt, so any
 * other small size on the same line is still a violation.
 */
const TOKEN_EXEMPT: Array<{ file: string; context: string; why: string }> = [
  { file: 'app/app/(protected)/tasks/TaskGrid.tsx', context: 'text-[9px] leading-none transition-transform duration-150', why: 'disclosure chevron glyph' },
  { file: 'app/app/(protected)/missions/[id]/CondensedTimeline.tsx', context: 'text-[9px] transition-transform duration-200', why: 'disclosure chevron glyph' },
  { file: 'app/app/(protected)/missions/[id]/CondensedTimeline.tsx', context: 'text-[9px] rotate-90 inline-block">▶', why: 'disclosure chevron glyph' },
  { file: 'app/app/(protected)/missions/[id]/CondensedTimeline.tsx', context: 'text-[10px]">▶</span>', why: 'disclosure chevron glyph' },
  { file: 'components/MissionsSidebar.tsx', context: 'text-[9px] font-bold rounded-full', why: 'desktop-only rail (hidden md:flex)' },
  { file: 'components/TeamSwitcherRail.tsx', context: 'text-[7px] font-mono uppercase', why: 'desktop-only rail (hidden md:flex)' },
];

/** A text-[Npx] token with its full variant chain, e.g. `dark:hover:text-[9px]`. */
const PX_TOKEN = /(?<![\w\]-])((?:[\w-]+(?:\[[^\]\s]*\])?:)*)text-\[(\d+(?:\.\d+)?)px\]/g;
const DESKTOP_ONLY_VARIANTS = new Set(['md', 'lg', 'xl', '2xl']);

export function smallTokensInLine(line: string): Array<{ token: string; index: number }> {
  const out: Array<{ token: string; index: number }> = [];
  for (const m of line.matchAll(PX_TOKEN)) {
    if (Number(m[2]) >= FLOOR) continue;
    const variants = m[1].split(':').filter(Boolean);
    if (variants.some(v => DESKTOP_ONLY_VARIANTS.has(v))) continue;
    out.push({ token: m[0], index: m.index! });
  }
  return out;
}

function sourceFiles(): string[] {
  const out: string[] = [];
  for (const f of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
    if (/\.test\.tsx?$/.test(f) || f.includes('/__tests__/')) continue;
    out.push(f);
  }
  return out;
}

function isExempt(rel: string, line: string, index: number): boolean {
  return TOKEN_EXEMPT.some(e => e.file === rel && line.startsWith(e.context, index));
}

describe('mobile type floor: token classification', () => {
  it('flags bare and mobile-reaching variants, skips md-and-up', () => {
    const toks = (l: string) => smallTokensInLine(l).map(t => t.token);
    expect(toks('text-[10px]')).toEqual(['text-[10px]']);
    expect(toks('max-md:text-[10px]')).toEqual(['max-md:text-[10px]']);
    expect(toks('sm:text-[9px]')).toEqual(['sm:text-[9px]']);
    expect(toks('dark:text-[9px] hover:text-[8px]')).toEqual(['dark:text-[9px]', 'hover:text-[8px]']);
    expect(toks('text-[11px] md:text-[10px] lg:text-[9px] xl:text-[8px] 2xl:text-[8px] md:hover:text-[9px]')).toEqual([]);
    expect(toks('text-[12px]')).toEqual([]);
  });

  it('an exemption covers only its own token, not the rest of the line', () => {
    const e = TOKEN_EXEMPT[0];
    const line = `<span className={\`${e.context} \${x}\`}><b className="text-[10px]">y</b></span>`;
    const small = smallTokensInLine(line);
    expect(small.length).toBe(2);
    expect(small.filter(t => !isExempt(e.file, line, t.index)).map(t => t.token)).toEqual(['text-[10px]']);
  });
});

describe('mobile type floor (markup)', () => {
  it('has no sub-11px text-[Npx] that can apply below md, outside the exemptions', () => {
    const violations: string[] = [];
    for (const rel of sourceFiles()) {
      const lines = readFileSync(join(SRC, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const t of smallTokensInLine(line)) {
          if (isExempt(rel, line, t.index)) continue;
          violations.push(`${rel}:${i + 1}: ${t.token}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('every exemption still matches a small token (no stale entries)', () => {
    const stale = TOKEN_EXEMPT.filter(e => {
      let src: string;
      try {
        src = readFileSync(join(SRC, e.file), 'utf8');
      } catch {
        return true;
      }
      return !src.split('\n').some(line => smallTokensInLine(line).some(t => isExempt(e.file, line, t.index)));
    });
    expect(stale).toEqual([]);
  });

  it('the scan actually sees the md-prefixed pattern (guards an empty match set)', () => {
    const stage = readFileSync(join(SRC, 'components/StageChip.tsx'), 'utf8');
    expect(stage).toContain('text-[11px] md:text-[10px]');
    expect(sourceFiles().length).toBeGreaterThan(100);
  });
});

/** px, or rem/em at a 16px root. */
function toPx(value: string, unit: string): number {
  return unit === 'px' ? Number(value) : Number(value) * 16;
}

interface CssRule { selectors: string[]; body: string; start: number }

/** Innermost rules (`sel, sel { decls }`), comments stripped, selectors split on commas. */
export function cssRules(source: string): CssRule[] {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length));
  const out: CssRule[] = [];
  for (const m of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const sel = m[1].trim();
    if (sel.startsWith('@')) continue;
    out.push({ selectors: sel.split(',').map(x => x.trim().replace(/\s+/g, ' ')).filter(Boolean), body: m[2], start: m.index! });
  }
  return out;
}

function smallFontSize(body: string): number | null {
  const m = /font-size:\s*(\d+(?:\.\d+)?)(px|rem|em)\b/.exec(body);
  if (!m) return null;
  const px = toPx(m[1], m[2]);
  return px < FLOOR ? px : null;
}

describe('mobile type floor (globals.css)', () => {
  const css = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');
  const FLOOR_MEDIA = '@media (width < 48rem)';

  function floorRange(): [number, number] {
    const start = css.indexOf(FLOOR_MEDIA);
    if (start === -1) throw new Error('mobile floor @media block not found in globals.css');
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return [start, i];
    }
    throw new Error('unterminated mobile floor block');
  }

  function floorSelectors(): Set<string> {
    const [a, b] = floorRange();
    const lifted = new Set<string>();
    for (const r of cssRules(css.slice(a, b + 1))) {
      const m = /font-size:\s*(\d+(?:\.\d+)?)(px|rem|em)\b/.exec(r.body);
      if (m && toPx(m[1], m[2]) >= FLOOR) r.selectors.forEach(x => lifted.add(x));
    }
    return lifted;
  }

  it('the rule parser splits grouped selectors and ignores comments', () => {
    const rules = cssRules('/* .x { font-size: 1px } */ @layer c { .a,\n .b .c { font-size: 9px } }');
    expect(rules.map(r => r.selectors)).toEqual([['.a', '.b .c']]);
  });

  it('lifts every sub-11px selector (grouped or not) to at least 11px below md', () => {
    const [a, b] = floorRange();
    const small = new Set<string>();
    for (const r of cssRules(css)) {
      if (r.start >= a && r.start <= b) continue;
      if (smallFontSize(r.body) !== null) r.selectors.forEach(x => small.add(x));
    }
    expect(small.size).toBeGreaterThan(0);
    const lifted = floorSelectors();
    expect([...small].filter(x => !lifted.has(x))).toEqual([]);
  });

  it('includes the section label and pills named in the mobile QA pass', () => {
    const lifted = floorSelectors();
    for (const cls of ['section-label-missions', 'status-pill', 'health-pill', 'field-label', 'type-label']) {
      expect(lifted.has(`.${cls}`)).toBe(true);
    }
  });
});
