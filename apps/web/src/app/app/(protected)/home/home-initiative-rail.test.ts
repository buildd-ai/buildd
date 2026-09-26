import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * docs/specs/initiatives.md: Home carries no initiative rail and no initiative
 * status line. The one initiative signal on Home is the progress headline
 * ("<title> crossed 75%"). Asserted against the module source rather
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

  it('still loads the initiative list the progress headline and queue chips read', () => {
    // Guards against over-deletion: the rail and the verdict line go, the loader stays.
    expect(source).toContain('loadInitiativeList');
    expect(source).toContain('crossedMilestone');
  });

  it('renders no derived initiative verdict', () => {
    expect(source).not.toContain('InitiativePulseLine');
    expect(source).not.toContain('initiative-pulse');
    expect(source).not.toContain('deriveInitiativeVerdict');
  });
});
