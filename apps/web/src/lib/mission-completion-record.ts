/**
 * The completion record as a reader sees it.
 *
 * `completeMission` (lib/mission-completion.ts) writes the "Mission completed"
 * note in a machine shape — a status histogram and a raw ISO evaluation time:
 *
 *   Deliverables: cancelled: 9, completed: 12
 *   Goal criteria: pass (evaluated 2026-01-01T00:00:00.000Z)
 *
 * Stored notes keep that shape (it is history, and other readers parse it), so
 * the mission page humanises it at render instead:
 *
 *   12 delivered · 9 cancelled
 *   Goal criteria: pass · evaluated 3h ago
 *
 * Lines it does not recognise pass through unchanged.
 */
import { timeAgo } from './mission-helpers';

/** Reading order after "delivered"; anything else follows alphabetically. */
const STATUS_ORDER = ['failed', 'cancelled'];

function formatDeliverables(rest: string): string | null {
  if (rest.trim() === 'none') return 'No deliverables';
  const counts = new Map<string, number>();
  for (const part of rest.split(',')) {
    const m = part.trim().match(/^([a-z_]+):\s*(\d+)$/);
    if (!m) return null;
    counts.set(m[1], Number(m[2]));
  }
  if (counts.size === 0) return null;
  const rank = (s: string) => (s === 'completed' ? -1 : STATUS_ORDER.includes(s) ? STATUS_ORDER.indexOf(s) : STATUS_ORDER.length);
  return [...counts.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([s, n]) => `${n} ${s === 'completed' ? 'delivered' : s.replace(/_/g, ' ')}`)
    .join(' · ');
}

function formatCriteria(line: string): string {
  const m = line.match(/^(Goal criteria: .*?)\s*\(evaluated ([^)]+)\)$/);
  if (!m) return line;
  const at = new Date(m[2]);
  if (Number.isNaN(at.getTime())) return line;
  return `${m[1]} · evaluated ${timeAgo(at)}`;
}

export function formatCompletionRecord(body: string): string {
  return body
    .split('\n')
    .map(line => {
      const deliverables = line.match(/^Deliverables:\s*(.*)$/);
      if (deliverables) return formatDeliverables(deliverables[1]) ?? line;
      if (line.startsWith('Goal criteria:')) return formatCriteria(line);
      return line;
    })
    .join('\n');
}

/**
 * A complete mission that renders its completion summary already answers
 * "is this done" — the situation block above it would only restate it
 * ("Complete — nothing outstanding. State is complete: …"). Any other state,
 * or a complete mission with no summary to show, keeps the situation block.
 */
export function situationRepeatsCompletion(
  state: string | null | undefined,
  hasCompletionSummary: boolean,
): boolean {
  return state === 'complete' && hasCompletionSummary;
}
