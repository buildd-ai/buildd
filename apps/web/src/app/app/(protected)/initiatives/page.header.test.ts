import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The Initiatives header follows Missions': a sans h1 hidden below md (the
 * shell header already names the page), one count line, a small `.btn` "+ New".
 * The page is an async server component with DB reads, so this pins the markup
 * at the source level.
 */
const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
const list = readFileSync(join(import.meta.dir, 'InitiativeList.tsx'), 'utf8');

describe('initiatives page header', () => {
  it('every h1 is a sans title hidden visually below md', () => {
    const h1s = src.match(/<h1[^>]*>/g) ?? [];
    expect(h1s.length).toBe(1);
    expect(h1s[0]).toContain('sr-only md:not-sr-only');
    expect(h1s[0]).not.toContain('font-mono');
  });

  it('the create entry is a small .btn, not an orange 2px frame', () => {
    const link = src.match(/<Link[^>]*data-testid="new-initiative-link"[^>]*>/)?.[0] ?? '';
    expect(link).toMatch(/className="btn\b/);
    expect(src).not.toMatch(/bg-prim[a]ry/);
    expect(src).not.toContain('border-2');
  });

  it('the empty state is a plain sentence, not a centred card', () => {
    expect(src).not.toMatch(/className="card\b/);
  });

  it('Completed collapses with the Disclosure primitive, not a local Show/Hide button', () => {
    expect(list).toContain("from '@/components/ui/Disclosure'");
    expect(list).not.toContain('useState');
    expect(list).not.toMatch(/Show \$\{|'Hide'/);
  });
});
