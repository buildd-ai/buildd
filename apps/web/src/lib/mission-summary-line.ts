/**
 * The one line under a mission's title: what the mission is for.
 *
 * Descriptions often open with context an agent needs and a reader does not —
 * "Prior attempts and why they failed — read before starting:" and a list.
 * Truncating the first paragraph put that preamble under the title as if it
 * were the goal. This picks the first sentence that states something: it skips
 * headings, list items, and label lines that only introduce what follows (a
 * line ending in a colon), and prefers an explicit `Goal:` line when there is
 * one. The full description stays one tap away.
 */

const GOAL_LABEL = /^(?:goal|objective|outcome|aim)\s*[:—-]\s*(.+)$/i;

function clean(line: string): string {
  return line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** First sentence: up to a `.`, `!` or `?` followed by a space (or the end), not a dotted token. */
function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(?=\s+[A-Z(“"']|\s*$)/.exec(text);
  return (m ? m[1] : text).trim();
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function missionSummaryLine(description: string | null | undefined): string | null {
  if (!description || !description.trim()) return null;
  const lines = description.split('\n').map(l => l.trim());

  for (const raw of lines) {
    const g = GOAL_LABEL.exec(clean(raw.replace(/^#+\s*/, '')));
    if (g && g[1].trim()) return capitalise(firstSentence(g[1].trim()));
  }

  for (const raw of lines) {
    if (!raw) continue;
    if (/^#{1,6}\s/.test(raw)) continue; // heading
    if (/^(?:[-*+]|\d+[.)])\s/.test(raw)) continue; // list item
    if (/^>/.test(raw)) continue; // quote
    const line = clean(raw);
    if (!line) continue;
    if (/:$/.test(line)) continue; // a label introducing what follows
    return firstSentence(line);
  }
  return null;
}
