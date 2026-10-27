/**
 * The Board/Lanes footer rows (Orchestrator, Records, Notes, Settings) run the
 * full width of the board above them. Capped at `max-w-3xl` they stopped at
 * about 60% of a desktop board, under a full-width grid. page.tsx is a server
 * component that needs a database, so this pins its markup at the source.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PAGE = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

describe('mission board footer', () => {
  const tag = PAGE.match(/<div data-testid="mission-board-footer"[^>]*>/)?.[0] ?? '';

  it('exists (the probe can fail)', () => {
    expect(tag).not.toBe('');
  });

  it('is not width-capped', () => {
    expect(tag).not.toMatch(/max-w-/);
  });
});

describe('board layout carries no Screens row or Goal criteria sheet (Navigation R-18)', () => {
  it('the Screens row renders only off the board layout', () => {
    expect(PAGE).toMatch(/layout !== 'board' && boardVisual && <MissionScreensRow/);
  });

  it('the Verified pill, which opens the Goal criteria sheet and its Run verification button, is not passed to the board header', () => {
    expect(PAGE).toContain("verified={layout === 'board' ? undefined : verifiedPill}");
    expect(PAGE).not.toMatch(/verified=\{verifiedPill\}/);
  });
});
