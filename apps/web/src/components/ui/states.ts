/**
 * The one table of display states: every pill, lifecycle step and strip cell
 * reads its glyph, word, tone and cell texture from here.
 *
 * Keys are the strip's display states (docs/specs/mission-progress-strip-ordering.md
 * §3.1, `StripState`) plus the delivery states the strip spec does not carry:
 * landing, recovering, not landed and needs you.
 *
 * Every state is distinguishable without colour: each has its own glyph, and
 * its cell has its own (pattern, frame) pair. `states.test.ts` holds both.
 */
/** The strip spec's display states (§3.1); the same union as `StripState` in lib/mission-task-strip.ts. */
export type StripDisplayState =
  | 'landed' | 'review' | 'running' | 'fixing' | 'waiting' | 'ci_failed' | 'failed'
  | 'ready' | 'blocked' | 'queued';

export type StateKey = StripDisplayState | 'landing' | 'recovering' | 'not_landed' | 'needs_you';

/** Hue family: ok (green), run (blue), act (orange, live), bad (red), q (neutral), dec (a decision). */
export type StateTone = 'ok' | 'run' | 'act' | 'bad' | 'q' | 'dec';

/** Cell fill shape, independent of hue. */
export type CellPattern =
  | 'solid' | 'empty' | 'flat'
  | 'hatch-horizontal' | 'hatch-vertical' | 'hatch-bold' | 'hatch-45'
  | 'hatch-dense' | 'hatch-sparse' | 'dots' | 'crosshatch';
/** Cell frame weight, independent of hue. */
export type CellFrame = 'none' | 'hairline' | 'decision' | 'heavy';

export interface StateDef {
  glyph: string;
  word: string;
  tone: StateTone;
  pattern: CellPattern;
  frame: CellFrame;
  /** Draw the glyph inside a large strip cell (flat fills need it to read in greyscale). */
  cellGlyph: boolean;
  means: string;
}

export const STATES: Record<StateKey, StateDef> = {
  running:    { glyph: '▶', word: 'Building',   tone: 'act', pattern: 'hatch-bold',       frame: 'none',     cellGlyph: false, means: 'An agent is producing a revision' },
  review:     { glyph: '◐', word: 'Auditing',   tone: 'run', pattern: 'hatch-vertical',   frame: 'none',     cellGlyph: false, means: 'Required checks are running on the current revision' },
  fixing:     { glyph: '↻', word: 'Repairing',  tone: 'act', pattern: 'hatch-45',         frame: 'none',     cellGlyph: true,  means: 'A check failed; Buildd is fixing it' },
  waiting:    { glyph: '◇', word: 'Waiting',    tone: 'act', pattern: 'empty',            frame: 'heavy',    cellGlyph: true,  means: 'The agent is paused, waiting on an answer' },
  ci_failed:  { glyph: '⊗', word: 'CI failed',  tone: 'bad', pattern: 'dots',             frame: 'none',     cellGlyph: true,  means: 'A required check failed on the current revision' },
  failed:     { glyph: '⊠', word: 'Failed',     tone: 'bad', pattern: 'crosshatch',       frame: 'none',     cellGlyph: true,  means: 'The task stopped without a revision to land' },
  landing:    { glyph: '▲', word: 'Landing',    tone: 'ok',  pattern: 'hatch-horizontal', frame: 'none',     cellGlyph: false, means: 'Every check passed; the merge is queued' },
  landed:     { glyph: '■', word: 'Landed',     tone: 'ok',  pattern: 'solid',            frame: 'none',     cellGlyph: false, means: 'Merged into its target branch' },
  ready:      { glyph: '□', word: 'Ready',      tone: 'q',   pattern: 'empty',            frame: 'hairline', cellGlyph: false, means: 'Nothing holds it; it starts when a slot frees' },
  blocked:    { glyph: '▦', word: 'Blocked',    tone: 'q',   pattern: 'hatch-dense',      frame: 'none',     cellGlyph: false, means: 'Waits on a dependency that is moving; starts by itself' },
  queued:     { glyph: '░', word: 'Queued',     tone: 'q',   pattern: 'hatch-sparse',     frame: 'none',     cellGlyph: false, means: 'Queued behind a chain that is itself waiting' },
  recovering: { glyph: '⊘', word: 'Recovering', tone: 'q',   pattern: 'flat',             frame: 'hairline', cellGlyph: true,  means: "A check can't run; Buildd is restoring it" },
  not_landed: { glyph: '✕', word: 'Not landed', tone: 'bad', pattern: 'flat',             frame: 'none',     cellGlyph: true,  means: 'The PR closed without merging' },
  needs_you:  { glyph: '!', word: 'Needs you',  tone: 'dec', pattern: 'flat',             frame: 'decision', cellGlyph: true,  means: 'A decision only a person can make' },
};

export const STATE_KEYS = Object.keys(STATES) as StateKey[];

export const isStateKey = (s: string): s is StateKey => Object.prototype.hasOwnProperty.call(STATES, s);

/** Full class strings (no interpolation) so Tailwind sees every one. */
export const TONE_TEXT: Record<StateTone, string> = {
  ok: 'text-status-success',
  run: 'text-status-info',
  act: 'text-accent-text',
  bad: 'text-status-error',
  q: 'text-[var(--q)]',
  dec: 'text-status-warning',
};
export const TONE_TINT: Record<StateTone, string> = {
  ok: 'bg-[var(--ok-tint)]',
  run: 'bg-[var(--run-tint)]',
  act: 'bg-accent-soft',
  bad: 'bg-[var(--bad-tint)]',
  q: 'bg-[var(--q-tint)]',
  dec: 'bg-accent-soft',
};

// ── Task and worker statuses ────────────────────────────────────────────────

/**
 * A task or worker row's status, read as a display state plus the word the
 * app already uses for it. This is what `StatusBadge` used to draw; the words
 * are unchanged so a page reads the same, only the pill is new.
 */
export const STATUS_PILL: Record<string, { state: StateKey; label: string }> = {
  pending:        { state: 'ready',      label: 'Pending' },
  assigned:       { state: 'running',    label: 'Assigned' },
  starting:       { state: 'running',    label: 'Starting' },
  running:        { state: 'running',    label: 'Running' },
  // A task row claimed and being worked (`tasks.status`); same word the task header uses.
  in_progress:    { state: 'running',    label: 'Running' },
  waiting_input:  { state: 'needs_you',  label: 'Needs input' },
  waiting_on_you: { state: 'needs_you',  label: 'Needs input' },
  // The subject-liveness claim gate excludes this task: no worker can ever
  // pick it up. See lib/subject-gate-contract.ts.
  subject_dead:   { state: 'not_landed', label: 'Subject closed' },
  completed:      { state: 'landed',     label: 'Completed' },
  failed:         { state: 'failed',     label: 'Failed' },
  cancelled:      { state: 'not_landed', label: 'Cancelled' },
  idle:           { state: 'ready',      label: 'Idle' },
  budget_limited: { state: 'waiting',    label: 'Waiting' },
  infra_failure:  { state: 'failed',     label: 'Infra error' },
  infra_stalled:  { state: 'recovering', label: 'Stalled' },
  // Not real task failures: a row no runner started, and a session that
  // streamed nothing. Neutral so they don't read as agent errors.
  never_started:  { state: 'queued',     label: 'Never started' },
  silent_start:   { state: 'recovering', label: 'No output' },
};

/** Status → pill. An unknown status keeps its own word on the neutral Ready pill. */
export function statusPill(status: string): { state: StateKey; label: string } {
  return STATUS_PILL[status] ?? { state: 'ready', label: status };
}
