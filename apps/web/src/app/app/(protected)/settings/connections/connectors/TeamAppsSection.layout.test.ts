import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Source-level guard for the team app row's mobile layout, carried over from
 * the old ConnectionsClient row test. The regression it pins: a row whose
 * action cluster kept its intrinsic width squeezed the name column on a 375pt
 * viewport, breaking the URL mid-token and reflowing the meta line.
 */
const src = readFileSync(resolve(import.meta.dir, 'TeamAppsSection.tsx'), 'utf8');

// From the row heading to the details panel: the always-visible row line.
const start = src.indexOf('const heading = (');
const row = src.slice(start, src.indexOf('id={panelId}', start));

describe('team app row layout', () => {
  it('keeps the name column shrinkable so it truncates rather than wrapping', () => {
    expect(row).toContain('min-w-0 flex-1');
    expect(row).toMatch(/block truncate text-meta/);
  });

  it('keeps the single action from wrapping or being squeezed', () => {
    expect(row).toContain('<div className="shrink-0">');
    expect(row).not.toContain('flex-wrap');
  });

  it('keeps the URL out of the row line; it lives in details and may break anywhere', () => {
    expect(row).not.toContain('{app.url}');
    expect(src).toContain('break-all font-mono text-meta text-text-muted">{app.url}');
  });
});
