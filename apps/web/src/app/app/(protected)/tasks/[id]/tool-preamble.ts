/**
 * Tool-call preambles: the short line a model writes right before calling a
 * tool ("Now let me check the decision…" + get_decision). The runner turns
 * "assistant text, then tool calls" into a `phase` milestone, so every such
 * line used to become its own Activity row and a tool-heavy run read as a
 * stack of "Now let me…" rows.
 *
 * The contract is structural, not lexical: a phase is by construction text
 * immediately followed by tool calls, and when its text is one short sentence
 * that reports nothing, the feed names the phase by what it called instead
 * ("Checked decision"). Wording like "let me" plays no part here. The raw text
 * stays on the milestone for the expanded row and the transcript.
 *
 * What keeps prose visible is substance, not phrasing: a finding, decision,
 * warning or result (see SUBSTANCE) leaves the row as written.
 */
import type { WorkerMilestone } from '@buildd/core/db/schema';

/** Longest phase text still treated as a lead-in. Longer prose is saying something. */
const PREAMBLE_MAX = 100;

/**
 * Markers of prose that carries content: findings and causes, decisions,
 * warnings, results, and negations (which almost always state a fact).
 */
const SUBSTANCE = new RegExp(
  [
    String.raw`\b(found|finds|discovered|noticed|turns\s+out|confirms?|confirmed|verified)\b`,
    String.raw`\b(because|caused|root\s+cause|the\s+(bug|issue|problem|cause|fix)\s+(is|was))\b`,
    String.raw`\b(decid(e|ed|ing)|chose|going\s+with|instead\s+of|conclu(de|ded|sion))\b`,
    String.raw`\b(warn(ing)?|careful|risk|danger|broke(n)?|regress(ion|ed)?)\b`,
    String.raw`\b(fail(s|ed|ing|ure)?|pass(es|ed)?|succeed(s|ed)?|works|worked|fixed|done|complete(d)?)\b`,
    String.raw`\b(not|no|never|isn't|aren't|doesn't|don't|didn't|wasn't|can't|cannot|won't|missing)\b`,
    String.raw`\b(i've|i\s+have|i\s+see|i\s+understand|now\s+i\s+(see|understand|know))\b`,
    String.raw`[!⚠✓✗]`,
  ].join('|'),
  'i',
);

/** Whether text states a finding, decision, warning or result — and so must stay visible. */
export function isSubstantive(text: string): boolean {
  return SUBSTANCE.test(text.replace(/[‘’]/g, "'"));
}

/**
 * Whether a milestone is a tool-call preamble: a phase (text that was followed
 * by tool calls) whose text is one short sentence with no substance.
 */
export function isToolPreamble(m: WorkerMilestone): boolean {
  if (m.type !== 'phase' || !(m.toolCount > 0)) return false;
  const text = m.label?.trim();
  if (!text) return false;
  if (text.length > PREAMBLE_MAX || text.includes('\n')) return false;
  // A second sentence means the line goes on to say something.
  if (/[.?!]\s+\S/.test(text.replace(/\.{3}|…/g, ''))) return false;
  return !isSubstantive(text);
}

// ── Naming a phase by its operations ─────────────────────────────────────────

/** Built-in tools, named for what they did. `null` = bookkeeping, never named. */
const TOOL_LABELS: Record<string, string | null> = {
  Read: 'Read files',
  Edit: 'Edited files',
  MultiEdit: 'Edited files',
  Write: 'Wrote files',
  NotebookEdit: 'Edited a notebook',
  Bash: 'Ran commands',
  Grep: 'Searched code',
  Glob: 'Searched code',
  WebFetch: 'Fetched a page',
  WebSearch: 'Searched the web',
  Task: 'Ran a subagent',
  Agent: 'Ran a subagent',
  Skill: 'Used a skill',
  AskUserQuestion: 'Asked a question',
  TodoWrite: null,
  ToolSearch: null,
};

/** Bare operation names with no object to name. */
const WHOLE_OPS: Record<string, string> = {
  learn: 'Saved knowledge',
  recall: 'Recalled knowledge',
  help: 'Read tool docs',
};

const VERBS: Record<string, string> = {
  get: 'Checked', read: 'Read', fetch: 'Fetched', check: 'Checked', list: 'Listed', query: 'Queried',
  view: 'Viewed', show: 'Checked', describe: 'Checked', inspect: 'Inspected', find: 'Found', search: 'Searched',
  load: 'Loaded', create: 'Created', add: 'Added', open: 'Opened', new: 'Created', update: 'Updated',
  edit: 'Edited', set: 'Set', patch: 'Updated', modify: 'Updated', save: 'Saved', store: 'Saved',
  write: 'Wrote', record: 'Recorded', delete: 'Deleted', remove: 'Removed', close: 'Closed',
  cancel: 'Cancelled', send: 'Sent', post: 'Posted', notify: 'Notified', merge: 'Merged', run: 'Ran',
  execute: 'Ran', trigger: 'Triggered', dispatch: 'Dispatched', start: 'Started', complete: 'Completed',
  finish: 'Finished', claim: 'Claimed', request: 'Requested', upload: 'Uploaded', deploy: 'Deployed',
  register: 'Registered', receive: 'Received', emit: 'Emitted', suggest: 'Suggested', approve: 'Approved',
  reject: 'Rejected', assign: 'Assigned', resolve: 'Resolved', retry: 'Retried', release: 'Released',
};

const ACRONYMS = new Set(['pr', 'prs', 'ci', 'api', 'url', 'mcp', 'id', 'ids', 'kb', 'ui', 'sha']);

function words(op: string): string[] {
  return op
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

function objectText(ws: string[]): string {
  return ws.map(w => (ACRONYMS.has(w) ? w.toUpperCase().replace(/S$/, 's') : w)).join(' ');
}

/** One operation as a past-tense phrase: `get_decision` → "Checked decision". */
export function describeOp(op: string): string | null {
  if (op in TOOL_LABELS) return TOOL_LABELS[op];
  if (op in WHOLE_OPS) return WHOLE_OPS[op];
  const ws = words(op);
  if (ws.length === 0) return null;
  const verb = VERBS[ws[0]];
  if (verb && ws.length > 1) return `${verb} ${objectText(ws.slice(1))}`;
  if (verb) return verb;
  return `Ran ${objectText(ws)}`;
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * A phase's operations as one feed label, in call order: "Checked decision",
 * "Read files, edited files and ran commands", "… and 2 more". Null when there
 * is nothing nameable (no ops, or bookkeeping only).
 */
export function describeOps(ops: readonly string[] | undefined, max = 3): string | null {
  if (!ops?.length) return null;
  const phrases: string[] = [];
  for (const op of ops) {
    const p = describeOp(op);
    if (p && !phrases.includes(p)) phrases.push(p);
  }
  if (phrases.length === 0) return null;
  const shown = phrases.slice(0, max).map((p, i) => (i === 0 ? p : lowerFirst(p)));
  const rest = phrases.length - shown.length;
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`;
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/** The tool-derived label for a preamble phase, or null when it has no `ops` to name it by. */
export function preambleActionLabel(m: WorkerMilestone): string | null {
  if (m.type !== 'phase') return null;
  return describeOps(m.ops);
}
