import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import TierSwitch from './TierSwitch';

/**
 * The trigger chip's label used to differ by viewport: "auto · standard" on
 * desktop (the routed-to tier only showed from `sm:` up) but just "auto" on a
 * phone, and the menu mixed "Auto" with lowercase tier names. One format,
 * sentence case, on every viewport (composer-format.test.ts covers the pure
 * label logic; this covers the chip actually using it, unconditionally).
 */
describe('TierSwitch — one label format on every viewport', () => {
  it('pinned tier: sentence case, no responsive class hiding part of it', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned="premium" last="budget" onChange={() => {}} />,
    );
    expect(html).toContain('Premium');
    expect(html).not.toContain('sm:inline');
  });

  it('auto, routed to a tier: "Auto · Standard" is not gated behind a breakpoint', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last="standard" onChange={() => {}} />,
    );
    expect(html).toContain('Auto · Standard');
    expect(html).not.toContain('sm:inline');
  });

  it('auto, nothing routed yet: just "Auto"', () => {
    const html = renderToStaticMarkup(
      <TierSwitch teamId="t1" conversationId={null} pinned={null} last={null} onChange={() => {}} />,
    );
    expect(html).toContain('Auto');
    expect(html).not.toContain('Auto · ');
  });
});
