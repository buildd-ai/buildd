/**
 * The canvas before the first message: a line on where things stand, and two
 * picked questions, so nobody has to know what to type (or that there are
 * shortcuts). Pure.
 *
 * The mood is deterministic: `needs` when anything waits on the viewer, else
 * `calm` (docs/design/chat-canvas.md, "Empty canvas"). Every number shown comes
 * from the pulse; nothing is invented, and a needs-you prompt is never offered
 * when nothing needs you.
 */
import { taskDisplayLabel } from '@buildd/core/task-label';
import { taskHeading } from '@/app/app/(protected)/tasks/[id]/task-header';

export interface CanvasSuggestion {
  label: string;
  /** What goes in the box. */
  text: string;
  /** Send right away (a question), or only fill the box (a starter to finish). */
  send: boolean;
  /** `needs`: this row is the thing waiting on the viewer (drawn copper). */
  tone?: 'needs';
}

/**
 * What the chat page already loads for its context panel: what waits on the
 * viewer (newest first) and how many agents are at work.
 */
export interface CanvasPulse {
  /** `action`: row 1's short action (needsYouAction); derived from the title when absent. */
  needsYou: readonly { title: string; action?: string }[];
  /** The list was cut at the loader's limit: the real count is at least its length. */
  needsYouCapped?: boolean;
  live: number;
}

/** Why a task waits on the viewer, as far as the page can tell. */
export interface NeedsYouSource {
  title: string;
  label?: string | null;
  /** `workers.waitingFor.type`: question | permission | confirmation. */
  waitingType?: string | null;
  /** A state beyond the question itself, when the loader knows one. */
  state?: 'tests_failed' | null;
}

/** Row 1 stays a few words: whole words only, never an ellipsis. */
const ACTION_MAX = 36;

/**
 * Picked row 1 on the needs-you canvas: a short action naming what to do,
 * derived only from state ("Answer the Stripe currency question", "Fix the
 * failing label change"). The subject is the task's short label
 * (taskDisplayLabel), trimmed a whole word at a time to fit; the full task
 * name stays in the italic sub line.
 */
export function needsYouAction(t: NeedsYouSource): string {
  const [pre, post] = t.state === 'tests_failed'
    ? ['Fix the failing', 'change']
    : t.waitingType === 'permission'
      ? ['Approve the', 'step']
      : t.waitingType === 'confirmation'
        ? ['Confirm the', 'change']
        : ['Answer the', 'question'];
  const words = taskDisplayLabel({ title: t.title, label: t.label ?? null }).label.split(/\s+/).filter(Boolean);
  while (words.length > 1 && `${pre} ${words.join(' ')} ${post}`.length > ACTION_MAX) words.pop();
  return words.length ? `${pre} ${words.join(' ')} ${post}` : `${pre} ${post}`;
}

/**
 * The waiting tasks as the pulse names them: the plain sentence every page
 * shows (taskHeading), never the raw "feat(scope): …" title, plus row 1's
 * short action.
 */
export function pulseNeedsYou(tasks: readonly NeedsYouSource[]): { title: string; action: string }[] {
  return tasks.map(t => ({ title: taskHeading({ title: t.title, label: t.label ?? null }, null).heading, action: needsYouAction(t) }));
}

export type CanvasMood = 'calm' | 'needs';

export interface CanvasHero {
  /** `SUN 27 SEP · CALM`; the date alone when the mood is unknown. */
  overline: string;
  mood: CanvasMood | null;
  hero: string;
  sub: string | null;
}

type About = { kind: string; title: string | null } | null | undefined;

export function canvasGreeting(name: string | null, about?: About): string {
  if (about) return about.title ? `Ask anything about ${about.title}.` : `Ask anything about this ${about.kind}.`;
  return name ? `Hi ${name}, what are we working on?` : 'Hi, what are we working on?';
}

/** Null without a pulse (the summoned canvas loads none): claim no mood. */
export function canvasMood(pulse: CanvasPulse | null | undefined): CanvasMood | null {
  if (!pulse) return null;
  return pulse.needsYou.length > 0 ? 'needs' : 'calm';
}

const WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const MOOD_LABEL: Record<CanvasMood, string> = { calm: 'CALM', needs: 'NEEDS YOU' };

function dayPart(now: Date, timeZone?: string): 'morning' | 'afternoon' | 'evening' {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now));
  return h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening';
}

function dateLabel(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone }).formatToParts(now);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('day')} ${get('month')}`.toUpperCase();
}

const agents = (n: number) => (n === 1 ? '1 agent is at work on its own' : `${n} agents are at work on their own`);

export function canvasHero(input: { pulse: CanvasPulse | null | undefined; name: string | null; about?: About; intent?: 'mission' | 'task' | null; now: Date; timeZone?: string }): CanvasHero {
  const { pulse, name, about, intent, now, timeZone } = input;
  const mood = canvasMood(pulse);
  const overline = mood ? `${dateLabel(now, timeZone)} · ${MOOD_LABEL[mood]}` : dateLabel(now, timeZone);
  if (about || intent) return { overline, mood, hero: canvasGreeting(name, about), sub: null };
  if (!pulse || !mood) {
    return { overline, mood, hero: canvasGreeting(name), sub: 'Ask about your work in plain words, or describe something to build.' };
  }
  if (mood === 'calm') {
    const tail = pulse.live > 0 ? `${agents(pulse.live)}.` : `A good ${dayPart(now, timeZone)} to start something.`;
    return { overline, mood, hero: 'All quiet.', sub: `Nothing is waiting on you. ${tail}` };
  }
  const n = pulse.needsYou.length;
  const first = pulse.needsYou[0].title;
  if (n === 1 && !pulse.needsYouCapped) {
    return { overline, mood, hero: 'One thing needs you.', sub: `“${first}” is waiting on your answer.` };
  }
  return {
    overline,
    mood,
    hero: pulse.needsYouCapped ? 'Several things need you.' : `${WORDS[n] ?? n} things need you.`,
    sub: pulse.needsYouCapped ? `“${first}” and more are waiting on you.` : `“${first}” and ${n - 1} more are waiting on you.`,
  };
}

const START: CanvasSuggestion = { label: 'Start something new', text: 'I want to build ', send: false };
const RUNNING: CanvasSuggestion = { label: "What's running right now?", text: "What's running right now?", send: true };
const SHIPPED: CanvasSuggestion = { label: 'What shipped this week?', text: 'What shipped this week?', send: true };

export function canvasSuggestions(
  entry: { intent: 'mission' | 'task' | null; about: 'mission' | 'task' | null },
  pulse?: CanvasPulse | null,
): CanvasSuggestion[] {
  if (entry.about === 'mission') {
    return [
      { label: 'How is it going?', text: 'How is this mission going?', send: true },
      { label: "What's holding it up?", text: "What's holding this mission up?", send: true },
      { label: "What's left?", text: "What's left before this mission is done?", send: true },
    ];
  }
  if (entry.about === 'task') {
    return [
      { label: 'Where is it at?', text: 'Where is this task at?', send: true },
      { label: "What's it doing now?", text: "What's the agent on this task doing right now?", send: true },
    ];
  }
  if (entry.intent) return [];
  // PICKED FOR YOU: exactly two rows, from what is actually going on.
  if (!pulse) return [RUNNING, START];
  const n = pulse.needsYou.length;
  if (n > 0) {
    const first = pulse.needsYou[0].title;
    const needs: CanvasSuggestion = n === 1 && !pulse.needsYouCapped
      ? { label: pulse.needsYou[0].action ?? needsYouAction({ title: first }), text: `What does "${first}" need from me?`, send: true, tone: 'needs' }
      : {
          label: pulse.needsYouCapped ? "Walk me through what's waiting on me" : `Walk me through the ${n} things waiting on me`,
          text: 'What needs me right now?',
          send: true,
          tone: 'needs',
        };
    return [needs, pulse.live > 0 ? RUNNING : SHIPPED];
  }
  if (pulse.live > 0) {
    const label = pulse.live === 1 ? 'What is the agent working on?' : `What are the ${pulse.live} agents working on?`;
    return [{ label, text: "What's running right now?", send: true }, START];
  }
  return [START, SHIPPED];
}

/** The composer's placeholder is the top suggestion; a starter trails off. */
export function canvasPlaceholder(suggestions: readonly CanvasSuggestion[]): string | undefined {
  const top = suggestions[0];
  if (!top) return undefined;
  return top.send ? top.label : `${top.label}…`;
}

/** The PICKED FOR YOU header's right-hand status. */
export function pickedStatus(pulse: CanvasPulse | null | undefined): string | null {
  if (!pulse) return null;
  const n = pulse.needsYou.length;
  if (n === 0) return 'nothing blocked';
  return pulse.needsYouCapped ? `${n}+ blocked` : `${n} blocked`;
}
