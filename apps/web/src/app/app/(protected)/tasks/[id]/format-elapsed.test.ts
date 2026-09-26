import { describe, expect, it } from 'bun:test';
import { formatElapsed } from './format-elapsed';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// The worker stats row used to render `Math.round(ms / 60000)m`, so a worker
// that had been running for two days read "2880m elapsed".
describe('formatElapsed', () => {
  it('shows <1m under a minute', () => {
    expect(formatElapsed(0)).toBe('<1m');
    expect(formatElapsed(59_000)).toBe('<1m');
  });

  it('shows whole minutes under an hour', () => {
    expect(formatElapsed(MIN)).toBe('1m');
    expect(formatElapsed(59 * MIN + 59_000)).toBe('59m');
  });

  it('shows hours and minutes under a day', () => {
    expect(formatElapsed(HOUR)).toBe('1h');
    expect(formatElapsed(HOUR + 5 * MIN)).toBe('1h 5m');
    expect(formatElapsed(23 * HOUR + 59 * MIN)).toBe('23h 59m');
  });

  it('shows days and hours from a day up', () => {
    expect(formatElapsed(DAY)).toBe('1d');
    expect(formatElapsed(2 * DAY + 3 * HOUR + 40 * MIN)).toBe('2d 3h');
  });

  it('never renders a negative duration (clock skew between server and browser)', () => {
    expect(formatElapsed(-5 * MIN)).toBe('<1m');
  });
});
