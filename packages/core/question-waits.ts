// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * What an agent's question sets in motion: the data behind the decision
 * card's summary, option and footer lines (Living Spec 1b257609 revision 2,
 * the data side of Navigation d25d923d R-16). The agent's brief
 * (./question-brief.ts) says what the question is and what each option means
 * to its own task. This is what buildd knows beyond that task, from its own
 * records and with no model:
 *
 * - R-1: the work that waits on the answer, from the claim route's own source:
 *   declared dependents one and two steps out, and the tasks queued behind a
 *   serial lane the asking task holds, with their positions. No guessed
 *   overlap: an edge the path-overlap pass added is not a declared one.
 * - R-2: the mission, and the outcome-spec criteria the task supplies
 *   evidence for.
 * - R-3: when the question expires and what happens then.
 * - R-4: per option, its outcome kind and that kind's effect on the waiting work.
 *
 * Computed once (apps/web/src/lib/question-waits.ts `loadQuestionWaits`, the
 * mission-state projection's question part) and read by every surface: the
 * card on Home, the mission page and the task page, the push, get_task and
 * explain (R-5, R-10). The words are here, so no surface writes its own.
 *
 * Text rules (R-9): names, never ids; a task, mission or spec in a summary is a
 * `WaitsPart` with an `href`; a task the viewer cannot see is counted, never
 * named; each fact once (the card already shows the asking task and its age).
 * Pure and safe to import from client components.
 */

/** What an option does to the asking task (R-4). */
export const OUTCOME_KINDS = ['continues', 'finishes', 'stops', 'changes'] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

export function parseOutcomeKind(v: unknown): OutcomeKind | undefined {
  if (typeof v !== 'string') return undefined;
  const k = v.trim().toLowerCase();
  return (OUTCOME_KINDS as readonly string[]).includes(k) ? (k as OutcomeKind) : undefined;
}

/**
 * The one fixed form the runner reads a kind from (R-11): an AskUserQuestion
 * option description that starts with the kind in square brackets, e.g.
 * `[finishes] Ships the fix as it is.` Any other description has no kind.
 * The tag is taken off the consequence.
 */
const OUTCOME_TAG = /^\s*\[\s*(continues|finishes|stops|changes)\s*\]\s*/i;

export function readOutcomeTag(description: string | null | undefined): { kind?: OutcomeKind; rest: string } {
  const d = description ?? '';
  const m = OUTCOME_TAG.exec(d);
  if (!m) return { rest: d };
  return { kind: m[1].toLowerCase() as OutcomeKind, rest: d.slice(m[0].length) };
}

/** Steering for agents: the runner's Communication section, the MCP `ask_human` entry, the guidance topic. */
export const OUTCOME_KIND_GUIDANCE =
  'Say what each option does to your task with an outcome kind: continues (you keep working), finishes (you complete the task), stops (the task fails) or changes (you deliver something different). ' +
  'buildd shows the person which other work starts, keeps waiting or fails for each kind.';

/** The AskUserQuestion half: the one form the runner reads (`readOutcomeTag`). */
export const OUTCOME_TAG_GUIDANCE =
  'Start each option description with its kind in square brackets, exactly: "[finishes] Ships the fix as it is." Any other form has no kind.';

// ── Data (R-10) ─────────────────────────────────────────────────────────────

export interface WaitingTask {
  id: string;
  title: string;
  /** 1: declared on the asking task. 2: declared on a depth-1 task. */
  depth: 1 | 2;
  missionId: string | null;
  missionTitle: string | null;
  /** Set only when the task is in another workspace than the asking task's. */
  workspaceName: string | null;
  /** Depth 2: the depth-1 task it waits after; null when that one is hidden. */
  after: { id: string; title: string } | null;
  /** Depth 1: another declared dependency is not done, so it does not start when this one finishes. */
  alsoWaitsOnOther: boolean;
}

/** A serial lane the asking task holds, and who is queued behind it (R-1b). */
export interface LaneWait {
  lane: string;
  /** In lane order: position 2 is next after the holder. */
  queued: Array<{ id: string; title: string; position: number }>;
  /** Queued tasks the viewer cannot see. */
  hiddenCount: number;
}

export interface QuestionOptionOutcome {
  label: string;
  outcome: OutcomeKind | null;
  /** `Finishes the task: B starts`. Null without a kind (R-4). */
  effect: string | null;
  recommended: boolean;
}

export type ExpiryAction =
  /** The task starts again without an answer and the agent takes its recommended option. */
  | 'default'
  /** The task starts again without an answer; the agent decides for itself. */
  | 'restart'
  /** The task stops waiting and ends. */
  | 'ends'
  /** The run ends and its delivery decides whether to start the task again. */
  | 'delivery';

export interface QuestionWaits {
  taskId: string;
  mission: { id: string; title: string } | null;
  /** Declared dependents the viewer may see, depth 1 first. */
  waiting: WaitingTask[];
  /** Declared dependents in workspaces the viewer cannot see: counted, never named. */
  hiddenCount: number;
  /** Open declared dependents three or more steps out. */
  beyondCount: number;
  lanes: LaneWait[];
  /** The outcome-spec criteria this task supplies evidence for (R-2), as ids for agents; cards give the count. */
  criteria: { specId: string; specTitle: string; affected: string[]; total: number } | null;
  askedAt: string | null;
  expiresAt: string | null;
  onExpiry: { action: ExpiryAction; option: string | null };
  options: QuestionOptionOutcome[];
}

// ── Words ───────────────────────────────────────────────────────────────────

export type WaitsPart = { text: string; href?: string };

export const NOTHING_WAITS = 'Nothing else waits on this answer';

export const taskHref = (id: string) => `/app/tasks/${id}`;
export const missionHref = (id: string) => `/app/missions/${id}`;
export const specHref = (id: string) => `/app/specs/${id}`;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** "30 minutes", "3 hours 30 minutes", "2 days 4 hours": the two largest units. */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000));
  if (total < 1) return 'less than a minute';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const units: string[] = [];
  if (days) units.push(`${days} ${plural(days, 'day', 'days')}`);
  if (hours) units.push(`${hours} ${plural(hours, 'hour', 'hours')}`);
  if (minutes && !days) units.push(`${minutes} ${plural(minutes, 'minute', 'minutes')}`);
  return units.slice(0, 2).join(' ');
}

const hiddenWords = (n: number) => (n === 1 ? "1 task you can't see" : `${n} tasks you can't see`);
const laneName = (lane: string) => `the ${lane} lane`;

/** Everything waiting, for counting: declared (seen, hidden, beyond) and lane-queued. */
function counts(w: Pick<QuestionWaits, 'waiting' | 'hiddenCount' | 'beyondCount' | 'lanes'>) {
  const lanes = w.lanes ?? [];
  const queued = lanes.reduce((n, l) => n + l.queued.length + l.hiddenCount, 0);
  return { declared: w.waiting.length + w.hiddenCount + w.beyondCount, queued, any: w.waiting.length + w.hiddenCount + w.beyondCount + queued > 0 };
}

/**
 * The declared work as one phrase: at most two names, `B, then C` when C waits
 * after B, `B and D` when both wait on the answer, then a count of the rest
 * and of what the viewer cannot see. Each name a link.
 */
function declaredParts(w: Pick<QuestionWaits, 'waiting' | 'hiddenCount' | 'beyondCount'>): WaitsPart[] {
  const named = w.waiting.slice(0, 2);
  const more = w.waiting.length - named.length + w.beyondCount;
  const tail: string[] = [];
  if (more > 0) tail.push(named.length ? `${more} more` : `${more} ${plural(more, 'task', 'tasks')}`);
  if (w.hiddenCount > 0) tail.push(hiddenWords(w.hiddenCount));
  const parts: WaitsPart[] = [];
  named.forEach((t, i) => {
    // `B, then C` when C waits after B; a plain list otherwise (`B, D and 2 more`).
    if (i === 1) parts.push({ text: t.depth === 2 && t.after?.id === named[0].id ? ', then ' : tail.length ? ', ' : ' and ' });
    parts.push({ text: t.title, href: taskHref(t.id) });
  });
  if (tail.length) parts.push({ text: `${parts.length ? ' and ' : ''}${tail.join(' and ')}` });
  return parts;
}

/**
 * The card's summary line (R-6, R-7), after the agent's own why: what waits on
 * the answer, the lanes it holds, and one clause on the mission's gate.
 */
export function waitsSummary(w: QuestionWaits): WaitsPart[] {
  const sentences: WaitsPart[][] = [];
  const c = counts(w);
  if (c.declared > 0) sentences.push([{ text: 'Waits on this: ' }, ...declaredParts(w)]);
  for (const l of w.lanes ?? []) {
    const n = l.queued.length + l.hiddenCount;
    if (n > 0) sentences.push([{ text: `Holds ${laneName(l.lane)}: ${n} queued` }]);
  }
  if (!c.any) {
    sentences.push(w.mission
      ? [{ text: 'Part of ' }, { text: w.mission.title, href: missionHref(w.mission.id) }, { text: `; ${NOTHING_WAITS.charAt(0).toLowerCase()}${NOTHING_WAITS.slice(1)}` }]
      : [{ text: NOTHING_WAITS }]);
  }
  if (w.criteria && w.criteria.affected.length > 0) {
    sentences.push([
      { text: `Affects the evidence for ${w.criteria.affected.length} of ${w.criteria.total} ${plural(w.criteria.total, 'criterion', 'criteria')} in ` },
      { text: w.criteria.specTitle, href: specHref(w.criteria.specId) },
    ]);
  }
  const out: WaitsPart[] = [];
  sentences.forEach((s, i) => {
    if (i > 0) out.push({ text: ' ' });
    out.push(...s, { text: '.' });
  });
  return out;
}

function expiryWords(w: QuestionWaits): string {
  switch (w.onExpiry.action) {
    case 'default':
      return `the task starts again and the agent goes with ${w.onExpiry.option ?? 'its recommendation'}`;
    case 'restart':
      return 'the task starts again and the agent decides for itself';
    case 'ends':
      return 'the task stops waiting and ends';
    case 'delivery':
      return 'this run ends and buildd decides whether to start the task again';
  }
}

/** The card's footer line (R-7): when it expires and what happens then. Null with no open question. */
export function waitsFooter(w: QuestionWaits, now: number = Date.now()): string | null {
  const expires = w.expiresAt ? Date.parse(w.expiresAt) : NaN;
  if (!Number.isFinite(expires)) return null;
  const left = expires - now;
  return left > 0
    ? `Expires in ${formatSpan(left)}, then ${expiryWords(w)}.`
    : `Expired: at the next check ${expiryWords(w)}.`;
}

/** A plain-text rendering of parts (push, MCP). */
export const partsText = (parts: readonly WaitsPart[]) => parts.map(p => p.text).join('');

/** "A", "A and B", "A, B and C". */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const KIND_WORDS: Record<OutcomeKind, string> = {
  continues: 'Keeps working',
  finishes: 'Finishes the task',
  stops: 'Stops the task',
  changes: 'Changes what it delivers',
};

/**
 * An option's effect line (R-4, R-8): the kind, then what it does to the
 * waiting work, mechanically. Finishing starts a dependent whose other
 * declared dependencies are done and frees a lane; stopping fails declared
 * dependents (and what waits after them: the failure cascades) and frees a
 * lane; continuing keeps both waiting.
 */
export function outcomeEffect(kind: OutcomeKind, w: Pick<QuestionWaits, 'waiting' | 'hiddenCount' | 'beyondCount' | 'lanes'>): string {
  const first = w.waiting.filter(t => t.depth === 1);
  const second = w.waiting.filter(t => t.depth === 2);
  const lanes = (w.lanes ?? []).filter(l => l.queued.length + l.hiddenCount > 0);
  const hidden = w.hiddenCount;
  const names = (ts: readonly WaitingTask[], extraHidden = 0) => [...ts.slice(0, 2).map(t => t.title), ...(ts.length > 2 ? [`${ts.length - 2} more`] : []), ...(extraHidden ? [hiddenWords(extraHidden)] : [])];
  const verb = (n: number, one: string, many: string) => (n === 1 ? one : many);
  const effects: string[] = [];
  switch (kind) {
    case 'continues': {
      const n = first.length + hidden;
      if (n > 0) effects.push(`${andList(names(first, hidden))} ${verb(n, 'keeps', 'keep')} waiting`);
      for (const l of lanes) effects.push(`keeps ${laneName(l.lane)}`);
      break;
    }
    case 'finishes':
    case 'changes': {
      const ready = first.filter(t => !t.alsoWaitsOnOther);
      const still = first.filter(t => t.alsoWaitsOnOther);
      const n = ready.length + hidden;
      if (n > 0) effects.push(`${andList(names(ready, hidden))} ${verb(n, 'starts', 'start')}${kind === 'changes' ? ' on the changed result' : ''}`);
      if (still.length > 0) effects.push(`${andList(names(still))} ${verb(still.length, 'still waits', 'still wait')} on another task`);
      for (const l of lanes) effects.push(`frees ${laneName(l.lane)}`);
      break;
    }
    case 'stops': {
      const n = first.length + hidden;
      if (n > 0) {
        const after = second.length > 0 ? `, then ${andList(names(second))}` : '';
        effects.push(`${andList(names(first, hidden))} ${verb(n, 'fails', 'fail')} too${after}`);
      }
      for (const l of lanes) effects.push(`frees ${laneName(l.lane)}`);
      break;
    }
  }
  return `${KIND_WORDS[kind]}: ${effects.length ? effects.join('; ') : 'nothing else waits on it'}`;
}

/** The options with their kinds and effects, recommended first (R-8). */
export function optionOutcomes(
  options: ReadonlyArray<string | { label?: unknown; outcome?: unknown; recommended?: unknown }> | null | undefined,
  w: Pick<QuestionWaits, 'waiting' | 'hiddenCount' | 'beyondCount' | 'lanes'>,
  recommendedLabel?: string | null,
): QuestionOptionOutcome[] {
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const out: QuestionOptionOutcome[] = [];
  for (const o of options ?? []) {
    const label = typeof o === 'string' ? o : typeof o?.label === 'string' ? o.label : '';
    if (!label.trim()) continue;
    const outcome = typeof o === 'string' ? undefined : parseOutcomeKind(o.outcome);
    const recommended = (typeof o !== 'string' && o.recommended === true) || (!!recommendedLabel && same(label, recommendedLabel));
    out.push({ label, outcome: outcome ?? null, effect: outcome ? outcomeEffect(outcome, w) : null, recommended });
  }
  return [...out.filter(o => o.recommended), ...out.filter(o => !o.recommended)];
}

/** The effect for one option label, matched case-insensitively. */
export function effectFor(w: QuestionWaits | null | undefined, label: string): string | null {
  const key = label.replace(/\s*[([]\s*recommended\s*[)\]]\s*$/i, '').trim().toLowerCase();
  return w?.options.find(o => o.label.trim().toLowerCase() === key)?.effect ?? null;
}

/** The facts as text lines (MCP, explain): summary, then footer. */
export function waitsText(w: QuestionWaits, now: number = Date.now()): string[] {
  return [partsText(waitsSummary(w)), waitsFooter(w, now)].filter((l): l is string => !!l);
}

/** One line for a push notification, after the question: what waits on it. */
export function waitsNotificationLine(w: QuestionWaits): string {
  return partsText(waitsSummary(w));
}
