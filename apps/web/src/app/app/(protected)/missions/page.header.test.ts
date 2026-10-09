import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The Missions header: a sans h1 hidden below md, one small `.btn` "+ New",
 * and the doors to Releases and Initiatives, which left the primary nav and
 * are reached from here. No chat nudge, no orange 2px create button. The page
 * is an async server component with DB reads, so this pins the markup at the
 * source level.
 */
const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('missions page header', () => {
  it('the h1 is a sans title, hidden visually below md', () => {
    const h1 = src.match(/<h1[^>]*data-testid="missions-headline"[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only md:not-sr-only');
    expect(h1).not.toContain('font-mono');
  });

  it('links to Releases and Initiatives from the header', () => {
    expect(src).toMatch(/<Link[^>]*href="\/app\/releases"[^>]*data-testid="missions-releases-link"/);
    expect(src).toMatch(/<Link[^>]*href="\/app\/initiatives"[^>]*data-testid="missions-initiatives-link"/);
  });

  it('the create entry is a small .btn, not an orange 2px frame', () => {
    const link = src.match(/<NewWorkLink[\s\S]*?>/)?.[0] ?? '';
    expect(link).toMatch(/className="btn\b/);
    expect(src).not.toMatch(/bg-prim[a]ry/);
    expect(src).not.toContain('border-2');
  });

  it('no chat setup nudge and no team label kicker on Missions', () => {
    expect(src).not.toContain('SetUpChatNudge');
    expect(src).not.toContain('section-label');
  });

  it('loads no release footers and no workspace list: neither renders here any more', () => {
    expect(src).not.toContain('loadReleaseFooterData');
    expect(src).not.toMatch(/workspaces=\{/);
  });

  it('empty states are plain sentences, not centred cards', () => {
    expect(src).not.toMatch(/className="card\b/);
  });
});
