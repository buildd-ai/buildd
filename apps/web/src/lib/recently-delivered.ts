/**
 * What "recently delivered" means (spec 3ef37387 R-24): a completed mission
 * whose delivery time is inside a window. One definition of the time and of
 * the test; each surface passes its own window, and the windows that differ
 * differ on purpose and are named here.
 *
 * The delivery time is the stored completion stamp, or the newest completion
 * note when that is later (an explicit reopen-and-complete keeps the first
 * stamp; see lib/missions-recent.ts, which reads the notes for the surface that
 * can afford the join). A completed mission with neither is not delivered.
 *
 * Pure: the missions list is a client component.
 */

/** buildd top and the missions list: a delivery stays listed this long. */
export const RECENTLY_DELIVERED_WINDOW_MS = 7 * 86_400_000;
/** Home's "just landed" row, deliberately shorter: Landed this week carries the rest. */
export const HOME_JUST_LANDED_WINDOW_MS = 12 * 3_600_000;

type Time = Date | string | number | null | undefined;
const ms = (t: Time): number | null => {
  if (t == null) return null;
  const n = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(t);
  return Number.isNaN(n) ? null : n;
};

/** When the mission was delivered: the later of the stamp and the newest completion note. */
export function deliveredAtMs(completedAt: Time, completionNoteAt?: Time): number | null {
  const a = ms(completedAt), b = ms(completionNoteAt);
  return a == null ? b : b == null ? a : Math.max(a, b);
}

/** Delivered inside the window ending at `now`. */
export function isRecentlyDelivered(
  m: { completedAt: Time; completionNoteAt?: Time },
  now: number,
  windowMs: number = RECENTLY_DELIVERED_WINDOW_MS,
): boolean {
  const at = deliveredAtMs(m.completedAt, m.completionNoteAt);
  return at != null && now - at < windowMs;
}
