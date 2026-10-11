/**
 * Chat has no palette of its own (globals.css, "Chat foreground"): each
 * --chat-* role is an alias of an app token, so the two cannot drift apart.
 * The only literals left are the scrim and the sea, which the second half
 * holds to AA: chat text on the sea's darkest and lightest frames, both themes.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { contrast, over, parse } from '../../app/globals-contrast.test';

const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

type Rgba = [number, number, number, number];

/** Every `--name: value;` declared in blocks whose selector matches (later wins). */
function declarations(selectorRe: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/^([^{}\n@][^{}]*)\{([^{}]*)\}/gm)) {
    if (!selectorRe.test(m[1].trim())) continue;
    for (const d of m[2].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  }
  return out;
}

const THEMES = {
  dark: { ...declarations(/^:root, \[data-theme\]$/), ...declarations(/^:root, \[data-theme="dark"\]$/) },
  light: { ...declarations(/^:root, \[data-theme\]$/), ...declarations(/^:root, \[data-theme="dark"\]$/), ...declarations(/^\[data-theme="light"\]$/) },
};

function resolve(theme: keyof typeof THEMES, name: string): string {
  let v = THEMES[theme][name];
  for (let i = 0; v?.startsWith('var(') && i < 8; i++) v = THEMES[theme][v.match(/var\(--([a-z0-9-]+)\)/)![1]];
  if (!v) throw new Error(`--${name} unresolved in ${theme}`);
  return v;
}
const rgba = (theme: keyof typeof THEMES, name: string): Rgba => parse(resolve(theme, name));

describe('chat tokens alias the app tokens', () => {
  const ALIASES: Record<string, string> = {
    'chat-ground': 'surface-1', 'chat-bar': 'surface-1', 'chat-surface': 'card', 'chat-raised': 'surface-3',
    'chat-rule': 'border', 'chat-rule-strong': 'faint', 'chat-text': 'text-primary', 'chat-muted': 'text-muted',
    'chat-dim': 'text-muted', 'mood-calm': 'q', 'mood-needs': 'status-warning', 'mood-needs-fill': 'accent',
    'on-mood-needs': 'on-accent', 'mood-thinking': 'status-info', 'mood-landed': 'status-success',
  };
  for (const [chat, app] of Object.entries(ALIASES)) {
    it(`--${chat} is var(--${app}) in both themes`, () => {
      expect(THEMES.dark[chat]).toBe(`var(--${app})`);
      expect(THEMES.light[chat]).toBe(`var(--${app})`);
      expect(THEMES.dark[app] ?? THEMES.light[app]).toBeDefined();
    });
  }

  it('the panel is the ground made see-through, not a second colour', () => {
    expect(THEMES.dark['chat-panel']).toContain('var(--surface-1)');
  });

  it('no chat or mood token is a literal colour, bar the scrim', () => {
    const literal = (t: Record<string, string>) => Object.entries(t)
      .filter(([k, v]) => /^(chat|mood|on-mood)-/.test(k) && !/^var\(|^color-mix\(/.test(v)).map(([k]) => k);
    expect(literal(THEMES.dark)).toEqual(['chat-scrim']);
    expect(literal(THEMES.light)).toEqual(['chat-scrim']);
  });

  it('violet is retired', () => {
    expect(css).not.toContain('--mood-thinking-alt');
    expect(css).not.toMatch(/--font-(plex-sans|ibm-plex-mono)/);
  });
});

describe('chat text over the sea', () => {
  // A blurred pool paints about 0.9x its declared alpha (calm, needs), 0.6x
  // for the smaller, faster thinking ones (measured by the visual validation).
  const MOODS: Record<string, { pools: string[]; peak: number }> = {
    calm: { pools: ['sea-calm-1', 'sea-calm-2', 'sea-calm-3', 'sea-calm-4'], peak: 0.9 },
    needs: { pools: ['sea-calm-1', 'sea-calm-2', 'sea-calm-3', 'sea-calm-4', 'sea-needs'], peak: 0.9 },
    thinking: { pools: ['sea-thinking-1', 'sea-thinking-2', 'sea-thinking-3', 'sea-thinking-4'], peak: 0.6 },
  };
  const scaled = (c: Rgba, peak: number): Rgba => [c[0], c[1], c[2], c[3] * peak];

  for (const theme of ['dark', 'light'] as const) {
    for (const [mood, { pools, peak }] of Object.entries(MOODS)) {
      it(`${theme} / ${mood}: text clears 4.5:1 on the bare ground (the lightest or darkest frame), each pool at peak, and, for body text, all of them stacked`, () => {
        const ground = rgba(theme, 'chat-ground');
        const single: Rgba[] = [ground, ...pools.map(p => over(scaled(rgba(theme, p), peak), ground))];
        // The extremes: the pools laid over each other, every one at once.
        const stacked = pools.reduce<Rgba>((under, p) => over(scaled(rgba(theme, p), peak), under), ground);
        // Body text is read anywhere on the sea, so it must hold on the stack.
        // A mood word sits over at most one pool (it is a label, not prose), so
        // it is held to the bare ground and each pool alone.
        const cases: Array<[string, Rgba[]]> = [
          ['chat-text', [...single, stacked]], ['chat-muted', [...single, stacked]],
          ['mood-needs', single], ['mood-thinking', single], ['mood-landed', single],
        ];
        for (const [text, frames] of cases) {
          for (const f of frames) expect(contrast(rgba(theme, text), f)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }

    it(`${theme}: the send arrow on its solid decision block clears 4.5:1`, () => {
      expect(contrast(rgba(theme, 'on-mood-needs'), rgba(theme, 'mood-needs-fill'))).toBeGreaterThanOrEqual(4.5);
    });
  }
});
