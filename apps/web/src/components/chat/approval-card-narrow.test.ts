/**
 * The approval card fits a 320px column (the /app/dev/chat?state=propose
 * audit at 320px scrolled sideways): buildd's theme of the kit card must not
 * undo the kit's wrapping. Three actions ("Confirm & file", "Edit",
 * "Discard") don't fit one row at 320px, so they wrap to a second.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
const rules = (sel: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(m => m[1].split(',').some(s => s.trim() === sel))
  .map(m => m[2]);

describe('approval card at 320px', () => {
  it('the action row wraps', () => {
    const actions = rules('.buildd-approval .kit-actions');
    expect(actions.length).toBeGreaterThan(0);
    for (const body of actions) expect(body).not.toMatch(/flex-wrap:\s*nowrap/);
  });

  it('no approval rule gives the card or its rows a min width or no-wrap', () => {
    for (const sel of ['.kit-card.buildd-approval', '.buildd-approval > .kit-card-head', '.buildd-approval > .kit-card-title']) {
      for (const body of rules(sel)) {
        expect(body).not.toMatch(/(^|[;\s])min-width:\s*(?!0)/);
        expect(body).not.toMatch(/white-space:\s*nowrap/);
      }
    }
  });
});
