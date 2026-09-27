import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT_CSS_VARS } from './index';

describe('theme.css', () => {
  const css = readFileSync(join(import.meta.dir, '..', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  it('defines exactly the --kit-* variables the components read', () => {
    const defined = [...css.matchAll(/(--kit-[a-z-]+)\s*:/g)].map(m => m[1]).sort();
    expect(defined).toEqual([...KIT_CSS_VARS].sort());
  });
  it('uses no Tailwind directives', () => {
    expect(css).not.toMatch(/@tailwind|@apply|@import\s+['"]tailwindcss/);
  });
});
