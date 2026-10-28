import { describe, expect, test } from 'bun:test';
import { freeSlots } from '../src/runner-liveness';

describe('freeSlots', () => {
  test('is capacity minus active', () => {
    expect(freeSlots(3, 1)).toBe(2);
    expect(freeSlots(3, 0)).toBe(3);
  });
  test('never goes negative when over-subscribed', () => {
    expect(freeSlots(2, 5)).toBe(0);
    expect(freeSlots(0, 0)).toBe(0);
  });
});
