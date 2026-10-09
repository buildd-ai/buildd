import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * At phone width the sticky mobile header already reads "Missions · Team", so
 * the page's own h1 must not render visually there too. The page is an async
 * server component with DB reads, so this pins the markup at the source level.
 */
const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('missions page h1 at phone width', () => {
  it('keeps the headline h1 for screen readers but hides it visually below md', () => {
    const h1 = src.match(/<h1[^>]*data-testid="missions-headline"[^>]*>/)?.[0] ?? '';
    expect(h1).not.toBe('');
    expect(h1).toContain('sr-only');
    expect(h1).toContain('md:not-sr-only');
  });

  it('every h1 on the page is hidden below md', () => {
    const h1s = src.match(/<h1[^>]*>/g) ?? [];
    expect(h1s.length).toBeGreaterThan(0);
    for (const h1 of h1s) expect(h1).toMatch(/sr-only md:not-sr-only|hidden md:block/);
  });
});
