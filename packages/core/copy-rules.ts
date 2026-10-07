/**
 * Copy rules for app UI strings: the sentence shapes that make a screen read
 * like an AI explaining itself. The test is "would GitHub, Linear or Claude
 * Code say this?" A setting has a label and, at most, one fact the label
 * can't carry. It doesn't narrate where things go, reassure, justify, or
 * apologise for being empty.
 *
 * Plain data, one list. `scripts/copy-check.ts` lints apps/web against it and
 * the copy rules in docs/design/design-system.md §5 point here. Word-level AI
 * vocabulary ("seamless", "leverage") is the stop-slop skill's job; in this
 * codebase the tell is sentence shape. Design: knowledge-base
 * buildd/design/prose-lint.md.
 */

export type CopyRuleId =
  | 'empty-yet'
  | 'of-your-own'
  | 'self-description'
  | 'reassurance'
  | 'justification'
  | 'needs-you'
  | 'exclamation'
  | 'long-copy';

export interface CopyRule {
  id: CopyRuleId;
  name: string;
  /** Matched against one rendered string, whitespace collapsed. */
  test: (text: string) => boolean;
  why: string;
  bad: string;
  good: string;
}

/** A string longer than this is an explanation, not UI copy. */
export const LONG_COPY_WORDS = 30;

const re = (r: RegExp) => (t: string) => r.test(t);

export const COPY_RULES: CopyRule[] = [
  {
    id: 'empty-yet',
    name: 'Empty state says "yet"',
    test: re(/\b(no|not)\b[^.?!]{0,60}\byet\b/i),
    why: 'An empty state states the fact. "Yet" nudges the reader toward a next step they did not ask about.',
    bad: 'No buckets of your own yet.',
    good: 'No buckets.',
  },
  {
    id: 'of-your-own',
    name: '"Of your own"',
    test: re(/\bof your own\b/i),
    why: 'Sales voice. Name the thing: "your bucket", "a team key".',
    bad: 'Use a bucket of your own.',
    good: 'Custom bucket',
  },
  {
    id: 'self-description',
    name: 'Copy describes its own screen',
    test: re(/^(where|what) [^.?!:]{3,60} (is|are) (kept|stored|configured|managed|set up)\b|^(this|the) (page|section|tab|screen) (shows|lists|holds|is where|is for)\b|^here (you can|is where)\b|^use this (page|section)\b|\b(lets|allows|helps|enables) you\b/i),
    why: 'The title already says what the page is. Cut the sentence or replace it with a fact the title cannot carry.',
    bad: 'Where run evidence is kept: failing command output, test reports, CI logs and transcripts.',
    good: 'Command output, test reports, CI logs and transcripts from agent runs.',
  },
  {
    id: 'reassurance',
    name: 'Reassurance',
    test: re(/\bnobody can\b|\bnothing to (configure|paste|do|worry|set up)\b|\bno file needed\b|\bdon[’']?t worry\b|\bno need to\b|\bsimply\b|\bseamless(ly)?\b|\bnothing to go stale\b|\b(re-?enable|change (it|this)|undo( it)?) any ?time\b|\bsettings (are|stay) unchanged\b/i),
    why: 'The reader did not ask to be reassured. State the property once, plainly: "Encrypted, write-only."',
    bad: 'Codex disabled. Re-enable any time; per-workspace settings are unchanged.',
    good: 'Codex disabled. Jobs run on Claude.',
  },
  {
    id: 'justification',
    name: 'Copy justifies itself',
    test: re(/\bas a backstop\b|\beven if\b|\bin order to\b|\bso (that )?you (can|don[’']?t|won[’']?t)\b|\bthat way\b/i),
    why: 'A setting does not argue for itself. Say what it does; drop the reason unless the reader needs it to choose.',
    bad: 'Add this rule as a backstop, so objects expire on the same day even if a delete is missed.',
    good: 'Expires objects after 30 days, matching buildd’s own cleanup.',
  },
  {
    id: 'needs-you',
    name: 'Dramatised count or demand',
    test: re(/\bthings? (needs?|waiting on) (you|me)\b|\bwaiting on (you|your|me)\b|\bneeds? your (attention|input|answer|decision|call|review|eyes|response|merge)\b|\bnothing needs you\b|\b(wants?|waiting for) your (answer|review|call|decision)\b|: your call\b/i),
    why: 'Name what is needed (input, a merge, a decision), not the person. The status word is "Needs input".',
    bad: '5 things need you',
    good: '5 to review',
  },
  {
    id: 'exclamation',
    name: 'Exclamation',
    test: re(/[a-z]!\s*$/i),
    why: 'UI copy does not cheer.',
    bad: 'Got it!',
    good: 'Saved.',
  },
  {
    id: 'long-copy',
    name: 'Wall of explanation',
    test: (t) => t.split(/\s+/).filter(Boolean).length > LONG_COPY_WORDS,
    why: `Over ${LONG_COPY_WORDS} words is a help article. Keep the one fact that changes what the reader does; link docs for the rest.`,
    bad: 'Chat follows these in every reply, and only you can see or change this list. When chat files a task or mission for you, the rules that apply are attached to it, so people in that workspace can see them on the task.',
    good: 'Chat follows these in every reply. Only you can edit them.',
  },
];

/** Every rule a string breaks. */
export function copyViolations(text: string): CopyRule[] {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return [];
  return COPY_RULES.filter((r) => r.test(t));
}
