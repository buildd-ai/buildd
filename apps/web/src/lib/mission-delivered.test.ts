import { describe, it, expect } from 'bun:test';
import { HOME_JUST_LANDED_WINDOW_MS, RECENTLY_DELIVERED_WINDOW_MS, deliveredAtMs, isRecentlyDelivered } from './mission-delivered';

const NOW = Date.parse('2026-10-18T12:00:00Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000);

describe('recently delivered', () => {
  it('names the two windows', () => {
    expect(RECENTLY_DELIVERED_WINDOW_MS).toBe(7 * 86_400_000);
    expect(HOME_JUST_LANDED_WINDOW_MS).toBe(12 * 3_600_000);
  });
  it('the later of stamp and completion note is the delivery time', () => {
    expect(deliveredAtMs(ago(30), ago(2))).toBe(ago(2).getTime());
    expect(deliveredAtMs(ago(2), ago(30))).toBe(ago(2).getTime());
    expect(deliveredAtMs(null, null)).toBeNull();
  });
  it('a re-completed mission is recent by its note, not its first stamp', () => {
    expect(isRecentlyDelivered({ completedAt: ago(24 * 20), completionNoteAt: ago(1) }, NOW)).toBe(true);
    expect(isRecentlyDelivered({ completedAt: ago(24 * 20) }, NOW)).toBe(false);
  });
  it('the window is the surface\'s own', () => {
    const m = { completedAt: ago(20) };
    expect(isRecentlyDelivered(m, NOW)).toBe(true);
    expect(isRecentlyDelivered(m, NOW, HOME_JUST_LANDED_WINDOW_MS)).toBe(false);
  });
  it('a mission with no delivery time is not delivered', () => {
    expect(isRecentlyDelivered({ completedAt: null }, NOW)).toBe(false);
  });
});
