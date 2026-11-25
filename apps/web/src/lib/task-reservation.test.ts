import { describe, test, expect } from 'bun:test';
import { liveReservation, reservationRemainingLabel } from './task-reservation';

const now = new Date('2026-11-22T12:00:00Z');
const res = (mins: number) => ({ reservedBy: { accountId: 'a1', at: '2026-11-22T11:40:00Z', expiresAt: new Date(now.getTime() + mins * 60_000).toISOString() } });

describe('liveReservation', () => {
  test('a reservation in the future is live', () => {
    expect(liveReservation(res(14), 'pending', now)).toEqual({ accountId: 'a1', expiresAt: res(14).reservedBy.expiresAt });
  });
  test('a lapsed reservation is hidden', () => {
    expect(liveReservation(res(-1), 'pending', now)).toBeNull();
    expect(liveReservation(res(0), 'pending', now)).toBeNull();
  });
  test('a claimed task hides it even if the stamp is still there', () => {
    expect(liveReservation(res(14), 'in_progress', now)).toBeNull();
    expect(liveReservation(res(14), 'completed', now)).toBeNull();
  });
  test('missing or malformed is null', () => {
    expect(liveReservation({}, 'pending', now)).toBeNull();
    expect(liveReservation(null, 'pending', now)).toBeNull();
    expect(liveReservation({ reservedBy: { accountId: 'a1', expiresAt: 'nope' } }, 'pending', now)).toBeNull();
    expect(liveReservation({ reservedBy: { expiresAt: res(5).reservedBy.expiresAt } }, 'pending', now)).toBeNull();
  });
});

describe('reservationRemainingLabel', () => {
  test('minutes, rounded up, singular and plural', () => {
    expect(reservationRemainingLabel(14 * 60_000)).toBe('for 14 more min');
    expect(reservationRemainingLabel(14 * 60_000 - 1)).toBe('for 14 more min');
    expect(reservationRemainingLabel(30_000)).toBe('for 1 more min');
  });
});
