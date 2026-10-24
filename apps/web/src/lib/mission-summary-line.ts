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

/** `Goal:`, `Owner goal:`, `Objective:`, … introduce the sentence the page leads with. */
const GOAL_LABEL = /^(?:(?:owner|product|mission|the)\s+)?(?:goal|objective|outcome|aim)\s*[:—-]\s*(.+)$/i;

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
  const first = (m ? m[1] : text).trim();
  // A heading-like word ("Specs.") states nothing: keep the sentence that follows it too.
  if (m && first.split(/\s+/).length < 3 && text.length > m[0].length) {
    const rest = text.slice(m[0].length).trim();
    if (rest) return `${first} ${firstSentence(rest)}`;
  }
  return first;
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** `against spec 36df686b-ee6b-…` (optionally `revision 1`): the Spec line already names it, so the goal sentence never carries the id (R-14). */
const SPEC_ID_RE = /(?:[\s,]+(?:against|per|from|in|for|of))?\s+spec\s+[0-9a-f]{8}(?:-[0-9a-f]{4}){0,4}(?:-[0-9a-f]*)?…?(?:\s+(?:revision|rev\.?|r)\s*\d+)?/gi;

function withoutSpecIds(line: string | null): string | null {
  if (!line) return line;
  const out = line.replace(SPEC_ID_RE, '').replace(/\s+([.,!?])/g, '$1').trim();
  return out || line;
}

export function missionSummaryLine(description: string | null | undefined): string | null {
  return withoutSpecIds(summaryLineOf(description));
}

function summaryLineOf(description: string | null | undefined): string | null {
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
