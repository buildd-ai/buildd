/**
 * The sea (docs/design/chat-canvas.md, "The sea"): soft round pools behind the
 * canvas, coloured by mood, slow, and still when the person asked for less
 * motion or the tab is hidden. Plus the single-glow invariant: the busy sweep
 * on the composer's top edge is the only glowing thing on the chat surface.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEA_POOLS, seaMood, seaMotion, seaPools } from './sea';

const SRC = join(import.meta.dir, '..', '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('pools', () => {
  it('eight or nine pools, 170-320px, drifting 24-44px', () => {
    expect(SEA_POOLS.length).toBeGreaterThanOrEqual(8);
    expect(SEA_POOLS.length).toBeLessThanOrEqual(9);
    for (const p of SEA_POOLS) {
      expect(p.size).toBeGreaterThanOrEqual(170);
      expect(p.size).toBeLessThanOrEqual(320);
      for (const d of [p.dx, p.dy]) {
        expect(Math.abs(d)).toBeGreaterThanOrEqual(24);
        expect(Math.abs(d)).toBeLessThanOrEqual(44);
      }
    }
  });

  it('calm loops take 29-52s; the thinking current adds a 14-23s loop', () => {
    for (const p of SEA_POOLS) {
      expect(p.calmSeconds).toBeGreaterThanOrEqual(29);
      expect(p.calmSeconds).toBeLessThanOrEqual(52);
      expect(p.thinkingSeconds).toBeGreaterThanOrEqual(14);
      expect(p.thinkingSeconds).toBeLessThanOrEqual(23);
    }
  });

  it('calm is teal only; needs swaps exactly one pool to copper; thinking is blue and violet', () => {
    const calm = seaPools('calm').map(p => p.colour);
    expect(calm.every(c => c.startsWith('var(--sea-calm-'))).toBe(true);
    const needs = seaPools('needs').map(p => p.colour);
    expect(needs.filter(c => c === 'var(--sea-needs)')).toHaveLength(1);
    expect(needs.filter(c => c !== calm[needs.indexOf(c)])).toHaveLength(1);
    const thinking = seaPools('thinking').map(p => p.colour);
    expect(thinking.every(c => c.startsWith('var(--sea-thinking-'))).toBe(true);
  });

  it('pools keep their place across moods, so a mood change cross-fades instead of jumping', () => {
    const a = seaPools('calm');
    const b = seaPools('thinking');
    expect(a.map(p => [p.x, p.y, p.size])).toEqual(b.map(p => [p.x, p.y, p.size]));
  });
});

describe('seaMood', () => {
  it('a turn in flight is thinking; otherwise the canvas mood, calm when unknown', () => {
    expect(seaMood({ busy: true, mood: 'needs' })).toBe('thinking');
    expect(seaMood({ busy: false, mood: 'needs' })).toBe('needs');
    expect(seaMood({ busy: false, mood: 'calm' })).toBe('calm');
    expect(seaMood({ busy: false, mood: null })).toBe('calm');
  });
});

describe('seaMotion', () => {
  it('reduced motion is static; a hidden tab pauses; otherwise it drifts', () => {
    expect(seaMotion({ reducedMotion: true, hidden: false })).toBe('static');
    expect(seaMotion({ reducedMotion: true, hidden: true })).toBe('static');
    expect(seaMotion({ reducedMotion: false, hidden: true })).toBe('paused');
    expect(seaMotion({ reducedMotion: false, hidden: false })).toBe('running');
  });
});

describe('css', () => {
  const css = read('app/globals.css');

  it('pool motion is transform-only, and stops for reduced motion', () => {
    for (const name of ['sea-drift', 'sea-current']) {
      const kf = css.slice(css.indexOf(`@keyframes ${name}`), css.indexOf('}', css.indexOf('}', css.indexOf(`@keyframes ${name}`)) + 1));
      expect(kf).toContain('transform');
      expect(kf).not.toMatch(/\b(left|top|width|height|margin)\s*:/);
    }
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map(m => m[1]).join('\n');
    for (const sel of ['.sea-pool', '.composer-sweep', '.thinking-tick', '.step-active']) expect(reduced).toContain(sel);
  });

  it('the sea is the only rounded layer in the chat styles, and it has no lines or streaks', () => {
    const radii = [...css.matchAll(/^\s*(\.[\w-]+)[^{]*\{[^}]*border-radius/gm)].map(m => m[1]);
    expect(radii.filter(s => s.startsWith('.sea') || s.startsWith('.composer') || s.startsWith('.thinking'))).toEqual(['.sea-pool']);
    const pool = css.slice(css.indexOf('.sea-pool {'), css.indexOf('}', css.indexOf('.sea-pool {')));
    expect(pool).toContain('radial-gradient');
    expect(pool).not.toContain('linear-gradient');
  });

  it('one glow only: the composer sweep is the one blurred shadow on the chat surface, and the old scan line is gone', () => {
    expect(css).not.toContain('.canvas-scan');
    const glows = [...css.matchAll(/^\s*([.\w-][^{\n]*)\{[^}]*box-shadow:\s*0 0 \d+px/gm)].map(m => m[1].trim());
    expect(glows.filter(s => /sea|composer|thinking|step|chat/.test(s))).toEqual(['.composer-sweep::after']);
    for (const f of ['components/chat/ChatComposer.tsx', 'components/chat/ChatFeed.tsx', 'components/chat/ChatWorkspace.tsx', 'components/chat/SeaLayer.tsx']) {
      expect(read(f)).not.toMatch(/shadow-\[0_0_|drop-shadow|0 0 \d+px/);
    }
  });
});

describe('AA over the sea', () => {
  const css = read('app/globals.css');
  const start = css.indexOf('--chat-ground: #141312');
  const dark = css.slice(start, css.indexOf('[data-theme="light"]', start));
  type RGB = [number, number, number];
  const token = (name: string): string => {
    const m = dark.match(new RegExp(`${name}:\\s*([^;]+);`));
    if (!m) throw new Error(`no ${name}`);
    return m[1].trim();
  };
  const rgba = (v: string): [number, number, number, number] => {
    if (v.startsWith('#')) return [parseInt(v.slice(1, 3), 16), parseInt(v.slice(3, 5), 16), parseInt(v.slice(5, 7), 16), 1];
    const n = (v.match(/[\d.]+/g) ?? []).map(Number);
    return [n[0], n[1], n[2], n[3] ?? 1];
  };
  const solid = (name: string): RGB => rgba(token(name)).slice(0, 3) as RGB;
  const over = (top: string, under: RGB): RGB => {
    const [r, g, b, a] = rgba(top);
    return [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
  };
  const lum = ([r, g, b]: RGB) => {
    const f = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a: RGB, b: RGB) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  it('the intent tag, muted on its own ground chip, clears 4.5:1', () => {
    expect(ratio(solid('--chat-muted'), solid('--chat-ground'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the send arrow on its solid copper block clears 4.5:1', () => {
    expect(ratio(solid('--on-mood-needs'), solid('--mood-needs-fill'))).toBeGreaterThanOrEqual(4.5);
  });

  it('dim text straight on the brightest pool would not, which is why the tag carries a chip', () => {
    const pools = ['--sea-calm-1', '--sea-calm-2', '--sea-calm-3', '--sea-thinking-1', '--sea-thinking-2', '--sea-needs'];
    const brightest = pools.map(p => over(token(p), solid('--chat-ground'))).sort((a, b) => lum(b) - lum(a))[0];
    expect(ratio(solid('--chat-dim'), brightest)).toBeLessThan(4.5);
  });
});
