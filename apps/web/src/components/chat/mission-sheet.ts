/**
 * The mission sheet (the summoned canvas over a mission, docs/design/chat-canvas.md
 * "Mission sheet"): what its context card says and which questions it offers.
 * Pure: everything is read from the mission's live board, nothing invented.
 *
 * "Disagrees" means the mission's own state contradicts itself or waits on the
 * viewer (complete with goal criteria unchecked, everything landed but not
 * complete, a task waiting on you). Only then is anything drawn copper.
 */
import type { CanvasSuggestion } from './canvas-empty';

export interface MissionSheetState {
  complete: boolean;
  planning: boolean;
  landed: { done: number; total: number };
  goal: { passed: number; total: number };
  needsYou: number;
  live: number;
}

/** The slice of MissionObjectView the sheet reads. */
export interface MissionSheetSource {
  status: string;
  board: {
    complete: boolean;
    planning: unknown | null;
    landed: { done: number; total: number };
    live: number;
    needsYou: readonly unknown[];
    criteria: readonly { state: string }[];
  };
}

export function missionSheetState(view: MissionSheetSource): MissionSheetState {
  const b = view.board;
  return {
    complete: b.complete || /^(completed|complete|done)$/i.test(view.status),
    planning: b.planning != null,
    landed: { done: b.landed.done, total: b.landed.total },
    goal: { passed: b.criteria.filter(c => c.state === 'pass').length, total: b.criteria.length },
    needsYou: b.needsYou.length,
    live: b.live,
  };
}

export interface MissionInsight { text: string; disagrees: boolean }

const unchecked = (s: MissionSheetState) => s.goal.total - s.goal.passed;
const allLanded = (s: MissionSheetState) => s.landed.total > 0 && s.landed.done >= s.landed.total;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function missionInsight(s: MissionSheetState): MissionInsight | null {
  if (s.complete && unchecked(s) > 0) {
    return { text: `Marked complete, but ${unchecked(s)} of ${s.goal.total} goal ${plural(s.goal.total, 'criterion is', 'criteria are')} unchecked.`, disagrees: true };
  }
  if (!s.complete && allLanded(s) && s.live === 0) {
    return { text: 'Everything landed, but it is not marked complete yet.', disagrees: true };
  }
  if (s.needsYou > 0) {
    return { text: `${s.needsYou} ${plural(s.needsYou, 'task is', 'tasks are')} waiting on you.`, disagrees: true };
  }
  if (s.complete) {
    return { text: s.goal.total > 0 ? 'Done, and every goal criterion checks out.' : 'Done.', disagrees: false };
  }
  if (s.planning && s.landed.total === 0) return { text: 'Still planning. No tasks yet.', disagrees: false };
  const landed = `${s.landed.done} of ${s.landed.total} landed.`;
  if (s.live > 0) return { text: `${s.live} ${plural(s.live, 'agent', 'agents')} at work, ${landed}`, disagrees: false };
  return { text: `Nothing running right now. ${landed}`, disagrees: false };
}

const ask = (label: string, text: string, tone?: 'needs'): CanvasSuggestion => ({ label, text, send: true, ...(tone ? { tone } : {}) });

const HOW = ask('How is it going?', 'How is this mission going?');
const HOLDING = ask("What's holding it up?", "What's holding this mission up?");
const LEFT = ask("What's left?", "What's left before this mission is done?");

/** ASK ABOUT: two or three rows (the plain three before the mission loads); row 1 is copper when it addresses the disagreement. */
export function missionAskRows(s: MissionSheetState | null): CanvasSuggestion[] {
  // Not loaded (or gone): the plain three, nothing claimed about its state.
  if (!s) return [HOW, HOLDING, LEFT];
  if (s.complete && unchecked(s) > 0) {
    const n = unchecked(s);
    return [
      ask(`Why ${plural(n, 'is 1 criterion', `are ${n} criteria`)} unchecked?`, `This mission is marked complete, but ${n} of ${s.goal.total} goal criteria are unchecked. Why, and what would check them?`, 'needs'),
      ask('What shipped?', 'What did this mission ship?'),
    ];
  }
  if (!s.complete && allLanded(s) && s.live === 0) {
    return [
      ask("Why isn't it complete yet?", 'Everything on this mission landed. Why is it not complete yet?', 'needs'),
      ask('What shipped?', 'What did this mission ship?'),
      LEFT,
    ];
  }
  if (s.needsYou > 0) {
    return [ask('What does it need from me?', 'What does this mission need from me?', 'needs'), HOW, LEFT];
  }
  if (s.complete) return [ask('What shipped?', 'What did this mission ship?'), ask('Anything to follow up?', 'Is there anything to follow up on this mission?')];
  if (s.planning && s.landed.total === 0) return [ask("What's the plan so far?", "What's the plan for this mission so far?"), HOW];
  return [HOW, HOLDING, LEFT];
}

/**
 * The phone object sheet's title bar. A mission's pane leads with its own
 * title, so the bar names only the kind ("Mission", not "Mission: X" above X).
 * A question stops saying it is waiting once it has been answered: the answer
 * is on its way until the agent picks it up.
 */
export function objectSheetTitle(
  ref: { kind: string; fallbackText: string },
  view?: { kind: string; open?: boolean; awaitingAgent?: boolean } | null,
): string {
  if (ref.kind === 'mission') return 'Mission';
  if (ref.kind === 'question' && view?.kind === 'question' && view.open === false) {
    return view.awaitingAgent ? 'Answer sent, waiting for the agent' : 'Question answered';
  }
  return ref.fallbackText;
}

/** The composer's locked scope cell. */
export function missionScopeLabel(workspaceName: string | null | undefined): string {
  return workspaceName ? `mission · ${workspaceName}` : 'mission';
}

/**
 * A segmented meter: one segment per item up to `max`, then scaled. Never
 * reads full until everything is done, never empty once anything is.
 */
export function segments(done: number, total: number, max = 10): boolean[] {
  if (total <= 0) return [];
  const n = Math.min(total, max);
  let filled = total <= max ? done : Math.round((done / total) * n);
  if (done > 0 && filled === 0) filled = 1;
  if (done < total && filled >= n) filled = n - 1;
  if (done >= total) filled = n;
  return Array.from({ length: n }, (_, i) => i < filled);
}
