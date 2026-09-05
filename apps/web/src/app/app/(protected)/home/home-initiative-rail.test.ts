import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * AC-6 (docs/specs/surface-ia-home-missions-initiatives.md §2.5, §1 placement
 * matrix): the 160px initiative card rail is MUST NOT on Home. Home carries the
 * one-line initiative pulse instead. Asserted against the module source rather
 * than a render because Home is an async server component with live DB reads —
 * the import itself is the thing the spec forbids ("`InitiativeRail` is not
 * imported by the Home page module").
 */
describe('Home — InitiativeRail is unmounted (AC-6)', () => {
  const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');

  it('does not import InitiativeRail', () => {
    expect(source).not.toContain('InitiativeRail');
  });

  it('leaves no dead rail plumbing behind', () => {
    expect(source).not.toContain('railInitiatives');
    expect(source).not.toContain('RAIL_LIMIT');
  });

  it('still loads the initiative list that the pulse line and arc headline read', () => {
    // Guards against over-deletion: the rail goes, the loader stays (§2.1 — the
    // arc headline mechanism is unchanged, and §6.2 keeps one loader).
    expect(source).toContain('loadInitiativeList');
    expect(source).toContain('sortedInitiatives');
  });
});
