import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * docs/specs/initiatives.md: Home carries no initiative rail and no initiative
 * status line. Initiatives reach Home only as the scoping chips over the
 * Needs-you list. (A progress headline was computed here once and never
 * rendered; spec 3ef37387 R-18 removed it.) Asserted against the module
 * source rather than a render because Home is an async server component with
 * live DB reads — the import itself is the thing the spec forbids
 * ("`InitiativeRail` is not imported by the Home page module").
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

  it('reads only the initiatives of the missions its cards name, for the chips', () => {
    // Guards against over-deletion: the chips stay, read from one join.
    expect(source).toContain('initiativeOfMission:');
    expect(source).toContain('<InitiativeFilterChips');
    // Nothing it does not show: no full initiative list, no headline, no per-user snapshot write.
    expect(source).not.toContain('loadInitiativeList');
    expect(source).not.toContain('crossedMilestone');
    expect(source).not.toContain('initiativeProgressSeen');
  });

  it('renders no derived initiative verdict', () => {
    expect(source).not.toContain('InitiativePulseLine');
    expect(source).not.toContain('initiative-pulse');
    expect(source).not.toContain('deriveInitiativeVerdict');
  });
});

describe('Home — the empty-initiative line shows only under an initiative filter', () => {
  const source = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
  it('"Nothing waiting for this initiative." is gated on initFilter', () => {
    const line = source.split('\n').find(l => l.includes('Nothing waiting for this initiative.')) ?? '';
    expect(line).toContain('initFilter &&');
  });
  it('the quiet-missions line gets its causes from the delivery projection', () => {
    expect(source).toContain('quietCauses: view.quietCauses');
    // Stored per mission (`quietCauseOf`), grouped here.
    expect(source).toContain('groupQuietCauses(');
  });
});
