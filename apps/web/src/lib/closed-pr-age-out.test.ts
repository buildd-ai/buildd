import { describe, it, expect } from 'bun:test';
import { closedPrAgedOutOfExplain, CLOSED_PR_AGE_OUT_DAYS } from './closed-pr-age-filter';

const NOW = new Date('2026-10-27T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

describe('closedPrAgedOutOfExplain', () => {
  it('ages out a closed PR on a standalone (no-mission) task after 15 days', () => {
    expect(closedPrAgedOutOfExplain({
      missionId: null,
      closedAt: daysAgo(15),
      now: NOW,
    })).toBe(true);
  });

  it('keeps listing a closed PR on a standalone task before 14 days', () => {
    expect(closedPrAgedOutOfExplain({
      missionId: null,
      closedAt: daysAgo(13),
      now: NOW,
    })).toBe(false);
  });

  it('keeps listing a closed PR on a task in an open mission whatever its age', () => {
    expect(closedPrAgedOutOfExplain({
      missionId: 'm-1',
      missionStatus: 'active',
      closedAt: daysAgo(30),
      now: NOW,
    })).toBe(false);
  });

  it('ages out a closed PR on a task whose mission is itself terminal', () => {
    expect(closedPrAgedOutOfExplain({
      missionId: 'm-1',
      missionStatus: 'completed',
      closedAt: daysAgo(20),
      now: NOW,
    })).toBe(true);
  });

  it('is exactly at the boundary at 14 days (ages out)', () => {
    expect(closedPrAgedOutOfExplain({
      missionId: null,
      closedAt: daysAgo(CLOSED_PR_AGE_OUT_DAYS),
      now: NOW,
    })).toBe(true);
  });

  it('never ages out when the close time is unknown', () => {
    expect(closedPrAgedOutOfExplain({ missionId: null, closedAt: null, now: NOW })).toBe(false);
    expect(closedPrAgedOutOfExplain({ missionId: null, closedAt: undefined, now: NOW })).toBe(false);
  });
});
