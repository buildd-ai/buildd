/** Client-safe reads of a workspace's "pause new starts" state (no db). */
export interface WorkspacePauseRow {
  id: string;
  name: string;
  /** ISO time, or null when not paused. */
  pausedUntil: string | null;
}

/** "until 6:00 PM" today, "until Wed, Jan 16, 9:00 AM" on another day. */
export function pauseUntilPhrase(until: string, now: Date = new Date()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return `until ${time}`;
  return `until ${at.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}
