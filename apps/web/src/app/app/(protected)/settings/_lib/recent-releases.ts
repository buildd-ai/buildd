/** Releases the Release section lists before folding the rest away. */
export const RELEASES_SHOWN = 5;

/**
 * Recent releases split for the Release section (settings spec R-9): the ones
 * that ran, newest first, and the skipped ones, which fold into one line
 * ("N skipped since <date>") instead of filling the table.
 */
export function splitRecentReleases<T extends { status: string | null; completedAt: string }>(rows: T[]) {
  const skipped = rows.filter((r) => r.status === 'skipped');
  const ran = rows.filter((r) => r.status !== 'skipped').slice(0, RELEASES_SHOWN);
  const skippedSince = skipped.length > 0
    ? skipped.reduce((oldest, r) => (r.completedAt < oldest ? r.completedAt : oldest), skipped[0].completedAt)
    : null;
  return { ran, skipped, skippedSince };
}
