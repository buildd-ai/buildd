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
  'components/chat/ComposerMenu.tsx',
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

  it('the colour roles exist in both themes', () => {
    const css = read('app/globals.css');
    for (const v of ['--chat-ground', '--chat-surface', '--chat-rule', '--chat-rule-strong', '--chat-text', '--chat-muted', '--mood-calm', '--mood-needs', '--mood-needs-fill', '--mood-thinking', '--mood-landed']) {
      expect(css.split(`${v}:`).length - 1).toBeGreaterThanOrEqual(2);
    }
  });
});
