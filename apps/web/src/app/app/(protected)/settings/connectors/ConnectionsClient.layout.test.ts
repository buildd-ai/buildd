import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Source-level guard (same approach as nav-config.test.tsx) for the connector
 * row's mobile layout. ConnectionsClient pulls in the whole connector/OAuth
 * client stack, so asserting on the markup source is cheaper than rendering it
 * and still catches the regression that mattered: an `items-start` row with a
 * non-shrinking action cluster squeezed the name/URL/reach column to ~40% of a
 * 375pt viewport, breaking the URL mid-token and reflowing the reach line to
 * five lines.
 */
const src = readFileSync(
  resolve(import.meta.dir, 'ConnectionsClient.tsx'),
  'utf8',
);

const row = src.slice(
  src.indexOf('{connectors.map((connector)'),
  src.indexOf('{showAddModal &&'),
);

describe('connector row layout', () => {
  it('stacks the info column above the actions on mobile', () => {
    expect(row).toContain('flex-col sm:flex-row');
  });

  it('does not force the action cluster to keep its intrinsic width on mobile', () => {
    expect(row).not.toContain('flex-shrink-0 flex-wrap');
    expect(row).toContain('sm:flex-shrink-0');
  });

  it('left-aligns the actions on mobile and right-aligns them from sm up', () => {
    expect(row).toContain('sm:justify-end');
  });

  it('keeps the info column shrinkable so the URL truncates rather than wrapping mid-token', () => {
    expect(row).toContain('min-w-0');
  });
});
