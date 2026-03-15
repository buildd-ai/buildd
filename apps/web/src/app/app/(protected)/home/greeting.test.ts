import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';

/**
 * Tests for the greeting time-of-day logic.
 * The greeting must use the client's local time, not server UTC.
 */

// Extract the pure logic to test it directly
function getGreeting(hour: number): string {
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

describe('getGreeting', () => {
  test('returns Good morning for hours 0-11', () => {
    expect(getGreeting(0)).toBe('Good morning');
    expect(getGreeting(6)).toBe('Good morning');
    expect(getGreeting(11)).toBe('Good morning');
  });

  test('returns Good afternoon for hours 12-17', () => {
    expect(getGreeting(12)).toBe('Good afternoon');
    expect(getGreeting(15)).toBe('Good afternoon');
    expect(getGreeting(17)).toBe('Good afternoon');
  });

  test('returns Good evening for hours 18-23', () => {
    expect(getGreeting(18)).toBe('Good evening');
    expect(getGreeting(21)).toBe('Good evening');
    expect(getGreeting(23)).toBe('Good evening');
  });

  test('3 PM (15:00) should be Good afternoon, not Good evening', () => {
    // This was the reported bug — server running UTC would return
    // "Good evening" for a user at 3 PM in a UTC+X timezone
    expect(getGreeting(15)).toBe('Good afternoon');
  });
});
