/**
 * Where the anchored panel lands. Regression: a wide, end-aligned panel (the
 * model picker's 620px) opened from a trigger near the left of the screen
 * clamped to the viewport's left edge and read as detached from "+ Add model".
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/', width: 1280, height: 800 });

import { afterEach, describe, expect, it } from 'bun:test';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { AnchoredPopover, placePopover } = await import('./AnchoredPopover');

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('placePopover', () => {
  it('right-aligns to the trigger when the panel fits to its left', () => {
    const p = placePopover(rect(900, 100, 120, 32), 1280, 800, { minWidth: 620, align: 'end' })!;
    expect(p.left + p.width).toBe(1020);
    expect(p.top).toBe(136);
  });

  it('falls back to the trigger\'s left edge instead of pinning to the viewport edge', () => {
    const p = placePopover(rect(260, 100, 110, 24), 1280, 800, { minWidth: 620, align: 'end' })!;
    expect(p.left).toBe(260);
    expect(p.width).toBe(620);
  });

  it('keeps the panel on screen and touching the trigger when neither edge fits', () => {
    const p = placePopover(rect(600, 100, 80, 24), 900, 800, { minWidth: 620, align: 'end' })!;
    expect(p.left).toBeGreaterThanOrEqual(8);
    expect(p.left + p.width).toBeLessThanOrEqual(892);
    // Overlaps the trigger horizontally.
    expect(p.left).toBeLessThanOrEqual(680);
    expect(p.left + p.width).toBeGreaterThanOrEqual(600);
  });

  it('flips above a trigger near the bottom, sitting right on top of it', () => {
    const p = placePopover(rect(260, 740, 110, 24), 1280, 800, { minWidth: 300, align: 'start' })!;
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(800 - 740 + 4);
    expect(p.left).toBe(260);
  });

  it('returns nothing for an anchor that is not laid out, rather than a corner', () => {
    expect(placePopover(rect(0, 0, 0, 0), 1280, 800, { minWidth: 620, align: 'end' })).toBeNull();
  });
});

describe('AnchoredPopover', () => {
  let host: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  async function mount(r: DOMRect) {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const anchorRef = createRef<HTMLButtonElement>();
    function Harness() {
      return (
        <>
          <button ref={anchorRef} type="button">+ Add model</button>
          <AnchoredPopover open onClose={() => {}} anchorRef={anchorRef} sheet={false} title="Add" minWidth={620} align="end" testId="panel">
            <div>rows</div>
          </AnchoredPopover>
        </>
      );
    }
    const proto = HTMLButtonElement.prototype as unknown as { getBoundingClientRect: () => DOMRect };
    const original = proto.getBoundingClientRect;
    proto.getBoundingClientRect = () => r;
    await act(async () => { root.render(<Harness />); });
    proto.getBoundingClientRect = original;
    return document.querySelector('[data-testid="panel"]') as HTMLElement;
  }

  it('renders next to a left-side trigger, not at the viewport edge', async () => {
    const panel = await mount(rect(260, 300, 110, 24));
    expect(panel.style.left).toBe('260px');
    expect(panel.style.top).toBe('328px');
    expect(panel.style.visibility).toBe('');
  });

  it('stays hidden while the anchor has no box', async () => {
    const panel = await mount(rect(0, 0, 0, 0));
    expect(panel.style.visibility).toBe('hidden');
  });
});
