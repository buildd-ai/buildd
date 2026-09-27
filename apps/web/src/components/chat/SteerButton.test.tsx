import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import SteerButton from './SteerButton';
import { CanvasContext } from './canvas-context';

describe('SteerButton', () => {
  it('renders nothing without a chat canvas in context (chat unavailable, or outside the protected layout)', () => {
    const html = renderToStaticMarkup(<SteerButton taskId="t1" />);
    expect(html).toBe('');
  });

  it('renders a labeled trigger when the canvas is available', () => {
    const html = renderToStaticMarkup(
      <CanvasContext.Provider value={{ open: () => {}, openSteer: () => {}, close: () => {}, isOpen: false }}>
        <SteerButton taskId="t1" />
      </CanvasContext.Provider>,
    );
    expect(html).toContain('data-testid="steer-trigger"');
    expect(html).toContain('Steer');
  });
});
