import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Lede always carries `max-w-prose`, which Tailwind emits after `max-w-none`,
// so a plain `max-w-none` loses. The inbox lede must use the important form to
// reach the card edge.
describe('spec approvals page lede width', () => {
  it('overrides Lede max-w-prose with the important modifier', () => {
    const src = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
    expect(src).toMatch(/<Lede className="[^"]*\bmax-w-none!/);
    expect(src).not.toMatch(/<Lede className="[^"]*\bmax-w-none(?!!)/);
  });
});
