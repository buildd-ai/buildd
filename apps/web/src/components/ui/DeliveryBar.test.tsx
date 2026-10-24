import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import DeliveryBar, { DELIVERY_END_MARK, deliveryBarName, type DeliveryOutcome } from './DeliveryBar';

const OUTCOMES: DeliveryOutcome[] = ['delivered', 'not-delivered', 'came-to-you'];
const html = (o: DeliveryOutcome, extra: { fixRounds?: number[]; start?: number; end?: number; verifyStart?: number } = {}) =>
  renderToStaticMarkup(<DeliveryBar start={0.2} end={0.6} outcome={o} {...extra} />);

describe('DeliveryBar (AC-15)', () => {
  it('draws a build segment and a verify segment', () => {
    const h = html('delivered');
    expect(h).toContain('data-segment="build"');
    expect(h).toContain('data-segment="verify"');
  });

  it('draws one tick per fix round', () => {
    expect([...html('delivered', { fixRounds: [0.3, 0.5] }).matchAll(/data-fix-tick/g)].length).toBe(2);
    expect(html('delivered')).not.toContain('data-fix-tick');
  });

  it('marks each outcome with a different glyph, not only a different colour', () => {
    expect(new Set(Object.values(DELIVERY_END_MARK)).size).toBe(3);
    expect(DELIVERY_END_MARK).toEqual({ delivered: '■', 'not-delivered': '✕', 'came-to-you': '!' });
    for (const o of OUTCOMES) expect(html(o)).toContain(`>${DELIVERY_END_MARK[o]}<`);
  });

  it('names the outcome and the fix rounds', () => {
    expect(deliveryBarName('delivered', 2)).toBe('delivered, 2 fix rounds');
    expect(deliveryBarName('not-delivered', 1)).toBe('not delivered, 1 fix round');
    expect(deliveryBarName('came-to-you', 0)).toBe('came to you, no fix rounds');
    expect(html('delivered', { fixRounds: [0.3, 0.4] })).toContain('role="img" aria-label="delivered, 2 fix rounds"');
  });

  it('lets a caller replace the name', () => {
    expect(renderToStaticMarkup(<DeliveryBar start={0} end={1} outcome="delivered" label="PR 12, delivered" />)).toContain('aria-label="PR 12, delivered"');
  });

  it('clamps offsets into the axis and survives end before start', () => {
    const h = html('delivered', { start: -1, end: 3, fixRounds: [9] });
    expect(h).toContain('left:0.000%');
    expect(h).toContain('left:100.000%');
    expect(() => html('delivered', { start: 0.8, end: 0.2 })).not.toThrow();
  });

  it('splits build and verify at verifyStart', () => {
    const h = renderToStaticMarkup(<DeliveryBar start={0} end={1} verifyStart={0.25} outcome="delivered" />);
    expect(h).toContain('width:25.000%');
    expect(h).toContain('width:75.000%');
  });
});
