/**
 * Radius scale: every corner comes from three radii (docs/design/design-system.md
 * §2.5): 3px strip cells, 4px pills and controls, 6px cards. globals.css
 * declares them once (`--radius-cell`, `--radius-pill`, `--radius-card`) and
 * tailwind.config.ts maps the whole `rounded-*` scale onto them, so `rounded`,
 * `rounded-lg` and `rounded-full` can only draw one of the three.
 *
 * What bypasses the scale, and is checked here: an arbitrary Tailwind value
 * (`rounded-[10px]`), an inline `borderRadius`, and a `border-radius`
 * declaration in globals.css. Each must be 0, a scale value, or a
 * `--radius-*` variable.
 *
 * The one exception is the chat conversation layer, soft by design and moving
 * onto the app's language in its own task: a line styled with the conversation
 * tokens (`--convo-*`), and the chat rules listed in CHAT_SOFT_SELECTORS.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';
import config from '../../tailwind.config';

const SRC = join(import.meta.dir, '..');
const CSS = readFileSync(join(import.meta.dir, 'globals.css'), 'utf8');

const SCALE_PX = ['3px', '4px', '6px'];
const SCALE_VARS = ['var(--radius-cell)', 'var(--radius-pill)', 'var(--radius-card)'];

/** True when a radius value is 0, a scale value, or a scale variable. */
export function onScale(value: string): boolean {
  const v = value.trim().replace(/\s*!important$/, '').replace(/^['"]|['"]$/g, '');
  return v === '0' || v === '0px' || v === 'inherit' || SCALE_PX.includes(v) || SCALE_VARS.includes(v);
}

/** `rounded-[10px]`, `rounded-r-[10px]`, `md:rounded-tl-[6px]` … with the bracket value. */
const ARBITRARY_RADIUS = /(?<![\w-])(?:[\w-]+:)*rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-\[([^\]\s]+)\]/g;

export function offScaleArbitraryRadii(line: string): string[] {
  return [...line.matchAll(ARBITRARY_RADIUS)].filter(m => !onScale(m[1])).map(m => m[0]);
}

/** Chat rules that stay soft until chat moves onto the app's language. */
const CHAT_SOFT_SELECTORS = [/^\.sea-pool\b/, /^\.buildd-thread > \.kit-error\b/, /^\.buildd-steer\b/];

/** Every `border-radius` declaration with the selector of the rule it sits in. */
export function radiusDeclarations(css: string): Array<{ selector: string; value: string }> {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, c => ' '.repeat(c.length));
  return [...src.matchAll(/(?<![\w-])border-radius:\s*([^;}]+)/g)].map(m => {
    const open = src.lastIndexOf('{', m.index);
    const start = Math.max(src.lastIndexOf('}', open), src.lastIndexOf('{', open - 1), src.lastIndexOf(';', open));
    return { selector: src.slice(start + 1, open).trim().replace(/\s+/g, ' '), value: m[1].trim() };
  });
}

describe('radiusDeclarations', () => {
  it('finds radii in one-line and multi-line rules, ignoring comments', () => {
    const css = '/* border-radius: 9px; */ .a { border-radius: 3px; } .b { color: red; border-radius: 8px; }\n.c {\n  border-radius: 0;\n}';
    expect(radiusDeclarations(css)).toEqual([
      { selector: '.a', value: '3px' },
      { selector: '.b', value: '8px' },
      { selector: '.c', value: '0' },
    ]);
  });
});

describe('onScale', () => {
  it('accepts 0, the three radii and their variables; rejects the rest', () => {
    for (const v of ['0', '3px', '4px', '6px', 'var(--radius-card)', '4px !important']) expect(onScale(v)).toBe(true);
    for (const v of ['2px', '8px', '50%', '0.5rem', '9999px']) expect(onScale(v)).toBe(false);
  });
});

describe('offScaleArbitraryRadii', () => {
  it('flags arbitrary radii off the scale, with variants and sides', () => {
    expect(offScaleArbitraryRadii('className="rounded-[10px] px-4"')).toEqual(['rounded-[10px]']);
    expect(offScaleArbitraryRadii('md:rounded-tl-[8px]')).toEqual(['md:rounded-tl-[8px]']);
  });

  it('leaves the named scale and on-scale arbitrary values alone', () => {
    expect(offScaleArbitraryRadii('rounded rounded-full rounded-lg rounded-r-md rounded-[6px] rounded-[var(--radius-cell)]')).toEqual([]);
  });
});

describe('radius scale', () => {
  it('globals.css declares the three radii', () => {
    expect(CSS).toMatch(/--radius-cell:\s*3px;/);
    expect(CSS).toMatch(/--radius-pill:\s*4px;/);
    expect(CSS).toMatch(/--radius-card:\s*6px;/);
  });

  it('every step of the Tailwind rounded-* scale is on the scale', () => {
    const scale = (config.theme?.extend?.borderRadius ?? {}) as Record<string, string>;
    expect(Object.keys(scale).length).toBeGreaterThan(0);
    for (const [k, v] of Object.entries(scale)) expect(`${k}: ${v} ${onScale(v)}`).toBe(`${k}: ${v} true`);
  });

  it('every border-radius in globals.css is on the scale, outside the chat soft layer', () => {
    const decls = radiusDeclarations(CSS);
    expect(decls.length).toBeGreaterThan(10);
    const hits = decls
      .filter(d => !CHAT_SOFT_SELECTORS.some(re => re.test(d.selector)) && !onScale(d.value))
      .map(d => `${d.selector} { border-radius: ${d.value} }`);
    expect(hits).toEqual([]);
  });

  it('no source file uses an arbitrary or inline radius off the scale, outside the conversation layer', () => {
    const hits: string[] = [];
    for (const f of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$/.test(f) || f.includes('/__tests__/')) continue;
      readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
        if (line.includes('var(--convo-')) return;
        for (const t of offScaleArbitraryRadii(line)) hits.push(`${f}:${i + 1} ${t}`);
        for (const r of line.matchAll(/borderRadius:\s*(['"][^'"]*['"]|\d+)/g)) {
          const v = /^\d+$/.test(r[1]) ? `${r[1]}px` : r[1];
          if (!onScale(v)) hits.push(`${f}:${i + 1} borderRadius: ${r[1]}`);
        }
      });
    }
    expect(hits).toEqual([]);
  });
});
