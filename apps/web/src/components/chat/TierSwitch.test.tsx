import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import TierSwitch, { tierOptions } from './TierSwitch';

/**
 * The trigger chip's label used to differ by viewport: "auto · standard" on
 * desktop (the routed-to tier only showed from `sm:` up) but just "auto" on a
 * phone. One format on every viewport, lowercase in the cell (v3 frame),
 * sentence case in the menu. The label is the kit's `tierLabel`; the
 * lowercase is buildd's CSS on the kit's trigger.
 */
const cell = (html: string) => html.match(/data-testid="kit-tier-trigger"[^>]*><span>([^<]*)</)?.[1];
const render = (pinned: 'premium' | null, last: string | null) =>
  renderToStaticMarkup(<TierSwitch teamId="t1" conversationId={null} pinned={pinned} last={last} onChange={() => {}} />);

describe('TierSwitch: one label format on every viewport', () => {
  it('the cell reads "Auto" / "Auto · Standard"; the accessible name says Tier', () => {
    const html = render(null, null);
    expect(cell(html)).toBe('Auto');
    expect(html).toContain('aria-label="Tier: Auto"');
    expect(cell(render(null, 'standard'))).toBe('Auto · Standard');
  });

  it('lowercase in the cell, on every viewport', () => {
    const css = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
    expect(css).toMatch(/\.buildd-menu-cell \[data-testid="kit-tier-trigger"\] \{ text-transform: lowercase; \}/);
  });

  it('pinned tier: no responsive class hiding part of it', () => {
    const html = render('premium', 'budget');
    expect(cell(html)).toBe('Premium');
    expect(html).not.toContain('sm:inline');
    expect(render(null, 'standard')).not.toContain('sm:inline');
  });

  it('the hover detail carries the running cost', () => {
    expect(render(null, null)).toContain('data-testid="tier-chat-cost"');
  });
});

describe('tierOptions', () => {
  it('three tiers; each names its model and per-1k price on its second line once loaded', () => {
    expect(tierOptions(null).map(o => o.tier)).toEqual(['budget', 'standard', 'premium']);
    expect(tierOptions(null).every(o => o.detail === undefined && o.price === undefined)).toBe(true);
    const opts = tierOptions([
      { tier: 'standard', model: 'm-mid', models: ['m-mid', 'm-alt'], inputPer1kUsd: 0.003, outputPer1kUsd: 0.015 },
    ]);
    expect(opts.find(o => o.tier === 'standard')?.detail).toBe('m-mid +1 · $0.003 / $0.015 per 1k');
    expect(opts.find(o => o.tier === 'standard')?.price).toBeUndefined();
    expect(opts.find(o => o.tier === 'budget')?.detail).toBeUndefined();
  });
});
