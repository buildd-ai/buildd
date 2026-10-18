/**
 * The one table of display states: every pill, lifecycle step and strip cell
 * reads its glyph, word, tone and cell texture from here.
 *
 * Keys are the strip's display states (docs/specs/mission-progress-strip-ordering.md
 * §3.1, `StripState`) plus the delivery states the strip spec does not carry:
 * landing, recovering, not_landed and needs_you.
 *
 * Every state is distinguishable without colour: each has its own glyph, and
 * its cell has its own (pattern, frame) pair. `states.test.ts` holds both.
 */
import { termFor, termWord, type Term } from '@buildd/shared';

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

/**
 * Glyph, word, tone and meaning from the terms catalog (`@buildd/shared` terms.ts)
 * for a strip state it covers; the cell texture stays here (it is CSS, not copy).
 */
function fromTerm(key: StateKey): Pick<StateDef, 'glyph' | 'word' | 'tone' | 'means'> {
  const t: Term = termFor({ kind: 'strip', value: key });
  return { glyph: t.glyph ?? '', word: t.word, tone: t.tone, means: t.means };
}

export const STATES: Record<StateKey, StateDef> = {
  running:    { ...fromTerm('running'), pattern: 'hatch-bold', frame: 'none', cellGlyph: false },
  review:     { ...fromTerm('review'), pattern: 'hatch-vertical', frame: 'none', cellGlyph: false },
  fixing:     { ...fromTerm('fixing'), pattern: 'hatch-45', frame: 'none', cellGlyph: true },
  waiting:    { ...fromTerm('waiting'), pattern: 'empty', frame: 'heavy', cellGlyph: true },
  ci_failed:  { ...fromTerm('ci_failed'), pattern: 'dots', frame: 'none', cellGlyph: true },
  failed:     { ...fromTerm('failed'), pattern: 'crosshatch', frame: 'none', cellGlyph: true },
  landing:    { ...fromTerm('landing'), pattern: 'hatch-horizontal', frame: 'none',     cellGlyph: false },
  landed:     { ...fromTerm('landed'),  pattern: 'solid',            frame: 'none',     cellGlyph: false },
  ready:      { ...fromTerm('ready'), pattern: 'empty', frame: 'hairline', cellGlyph: false },
  blocked:    { ...fromTerm('blocked'), pattern: 'hatch-dense', frame: 'none', cellGlyph: false },
  queued:     { ...fromTerm('queued'), glyph: '░', pattern: 'hatch-sparse', frame: 'none', cellGlyph: false },
  recovering: { ...fromTerm('recovering'), pattern: 'flat', frame: 'hairline', cellGlyph: true },
  not_landed: { ...fromTerm('not_landed'), pattern: 'flat',      frame: 'none',     cellGlyph: true },
  needs_you:  { ...fromTerm('needs_you'), pattern: 'flat', frame: 'decision', cellGlyph: true },
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
  pending:        { state: 'ready',      label: termWord('work.ready') },
  assigned:       { state: 'running',    label: termWord('work.working') },
  starting:       { state: 'running',    label: termWord('work.working') },
  running:        { state: 'running',    label: termWord('work.working') },
  // A task row claimed and being worked (`tasks.status`); same word the task header uses.
  in_progress:    { state: 'running',    label: termWord('work.working') },
  // Said in words, not a label: a parked agent is waiting for an answer.
  waiting_input:  { state: 'needs_you',  label: termWord('work.has_question') },
  waiting_on_you: { state: 'needs_you',  label: termWord('decision.waiting_on_you') },
  // The subject-liveness claim gate excludes this task: no worker can ever
  // pick it up. See lib/subject-gate-contract.ts.
  subject_dead:   { state: 'not_landed', label: 'Superseded' },
  // A finished task reads Done (work.done). The merged cell is kept: work.done
  // and pr.merged share the glyph and tone, and a strip state only exists per PR.
  completed:      { state: 'landed',     label: 'Done' },
  failed:         { state: 'failed',     label: 'Failed' },
  cancelled:      { state: 'not_landed', label: 'Cancelled' },
  idle:           { state: 'ready',      label: termWord('work.ready') },
  budget_limited: { state: 'queued',     label: termWord('wait.usage_limit') },
  infra_failure:  { state: 'failed',     label: 'Runner error' },
  infra_stalled:  { state: 'recovering', label: 'Stalled' },
  // Not real task failures: a row no runner started, and a session that
  // streamed nothing. Neutral so they don't read as agent errors.
  never_started:  { state: 'queued',     label: 'Not started' },
  silent_start:   { state: 'recovering', label: 'No output' },
};

/** Status → pill. An unknown status keeps its own word on the neutral Ready pill. */
export function statusPill(status: string): { state: StateKey; label: string } {
  return STATUS_PILL[status] ?? { state: 'ready', label: status };
}
