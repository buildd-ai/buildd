/**
 * The chat foreground is square (docs/design/chat-canvas.md, "Mobile canvas"):
 * the composer, its control cells, the scope cell and the empty canvas carry
 * no border radius and no hardcoded colour; they read the chat colour roles
 * in globals.css. The soft conversation bubbles are a separate surface.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dir, '..', '..');
const read = (f: string) => readFileSync(join(SRC, f), 'utf8');

const FOREGROUND = [
  'components/chat/ChatComposer.tsx',
  'components/chat/KitMenuCell.tsx',
  'components/chat/TierSwitch.tsx',
  'components/chat/ToolsMenu.tsx',
  'components/chat/ChatWorkspace.tsx',
];

describe('chat foreground', () => {
  for (const f of FOREGROUND) {
    it(`${f}: no border radius`, () => {
      expect(read(f).match(/(?<![\w-])(?:[\w-]+:)*rounded(?:-[\w[\]./]+)?/g) ?? []).toEqual([]);
    });
    it(`${f}: no hardcoded hex colour`, () => {
      expect(read(f).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    });
  }

  it('the composer scope cell is square', () => {
    const sw = read('components/WorkspaceSwitcher.tsx');
    const chip = sw.slice(sw.indexOf('data-testid="composer-scope-chip"'), sw.indexOf('</button>', sw.indexOf('data-testid="composer-scope-chip"')));
    expect(chip).not.toMatch(/rounded/);
  });

  it('one top rule: the focused composer draws no second line', () => {
    // The global `:focus-visible` ring (2px accent, 2px offset) is unlayered,
    // so it beats Tailwind's `focus-visible:outline-none` and drew two copper
    // lines across the full-width box: one along the slab's top rule, one over
    // the toolbar. The composer's focus cue is its own top rule instead.
    const css = read('app/globals.css');
    const ring = css.indexOf(':focus-visible {');
    const off = css.search(/textarea\[data-composer-input\]:focus-visible\s*\{[^}]*outline:\s*none/);
    expect(ring).toBeGreaterThanOrEqual(0);
    expect(off).toBeGreaterThan(ring);
    const composer = read('components/chat/ChatComposer.tsx');
    expect(composer).toMatch(/<textarea[\s\S]*?data-composer-input[\s\S]*?\/>/);
    // The toolbar's own rule is the quiet 1px one, never a mood colour.
    const toolbar = composer.slice(composer.indexOf('data-testid="composer-toolbar"'), composer.indexOf('>', composer.indexOf('data-testid="composer-toolbar"')));
    expect(toolbar).toContain('border-t border-[var(--chat-rule)]');
    expect(toolbar).not.toMatch(/mood-needs|accent/);
  });

  it('the colour roles exist in both themes', () => {
    const css = read('app/globals.css');
    for (const v of ['--chat-ground', '--chat-surface', '--chat-rule', '--chat-rule-strong', '--chat-text', '--chat-muted', '--mood-calm', '--mood-needs', '--mood-needs-fill', '--mood-thinking', '--mood-landed']) {
      expect(css.split(`${v}:`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
