import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TierSwitch from './TierSwitch';

/**
 * The trigger chip's label used to differ by viewport: "auto · standard" on
 * desktop (the routed-to tier only showed from `sm:` up) but just "auto" on a
 * phone, and the menu mixed "Auto" with lowercase tier names. One format on
 * every viewport, lowercase in the cell (v3 frame), sentence case in the menu (composer-format.test.ts covers the pure
 * label logic; this covers the chip actually using it, unconditionally).
 */
const cell = (html: string) => html.match(/data-testid="composer-tier-label"[^>]*>([^<]*)</)?.[1];

describe('TierSwitch: one label format on every viewport', () => {
  it('the cell reads lowercase like the v3 frame (`auto ▾`); the accessible name keeps sentence case', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last={null} onChange={() => {}} />,
    );
    expect(cell(html)).toBe('auto');
    expect(html).toContain('aria-label="Tier: Auto"');
    const routed = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last="standard" onChange={() => {}} />,
    );
    expect(cell(routed)).toBe('auto · standard');
  });

  it('pinned tier: no responsive class hiding part of it', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned="premium" last="budget" onChange={() => {}} />,
    );
    expect(cell(html)).toBe('premium');
    expect(html).not.toContain('sm:inline');
  });

  it('auto, routed to a tier: the routed tier is not gated behind a breakpoint', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last="standard" onChange={() => {}} />,
    );
    expect(cell(html)).toBe('auto · standard');
    expect(html).not.toContain('sm:inline');
  });

  it('auto, nothing routed yet: just "Auto"', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last={null} onChange={() => {}} />,
    );
    expect(cell(html)).toBe('auto');
  });
});
