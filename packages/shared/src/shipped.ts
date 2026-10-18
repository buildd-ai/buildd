// ============================================================================
// MISSION "WHAT SHIPPED" CONTRACT
// ============================================================================
//
// The owner-facing answer to "what changed for me?" that the agent already
// proposing a mission's completion writes in the output it already returns
// (knowledge-base: buildd/design/mission-shipped-report.md). One definition, shared by
// `planningOutputSchema` and the evaluation output schema so the two cannot
// drift.
//
// What the model writes: `lede`, `offPlan`, and a NOMINATION of `heroShots`.
// What the server owns: change type, which screenshots exist, and whether the
// lede is fit to show. The model can only select, never assert.

import type { TaskHandoff } from './types';

/** Longest lede shown, in characters. The same bound as the PR lede. */
export const SHIPPED_LEDE_MAX_CHARS = 240;
/** At most this many off-plan lines are kept. */
export const SHIPPED_OFF_PLAN_MAX_LINES = 2;
/** Each off-plan line is cut to this many characters. */
export const SHIPPED_OFF_PLAN_LINE_MAX_CHARS = 160;
/** At most this many hero shots are nominated or picked. */
export const SHIPPED_HERO_SHOTS_MAX = 3;

export interface ShippedOutput {
  /** 1-2 plain sentences: what changed for the user. */
  lede: string;
  /** Surface-audit screenshot artifact ids, only when any were listed. */
  heroShots?: string[];
  /** At most 2 lines; only when delivered work materially differs from the description. */
  offPlan?: string[];
}

export const shippedOutputSchema = {
  type: 'object',
  description:
    'Fill this when you set missionComplete (or return verdict "complete"): the plain-language answer to ' +
    '"what changed for me?" for the person who asked for this mission. Omit it otherwise.',
  properties: {
    lede: {
      type: 'string',
      description:
        `ONE or TWO plain sentences for someone who has read none of the mission's pull requests: what is ` +
        'different for them now, and if the change was visual, whether anyone looked at it. No file paths, ' +
        'route or endpoint names, symbol or function names, class names, PR numbers, or internal vocabulary. ' +
        `Max ${SHIPPED_LEDE_MAX_CHARS} characters.`,
    },
    heroShots: {
      type: 'array',
      items: { type: 'string' },
      description:
        `Only if screenshots are listed in your instructions: up to ${SHIPPED_HERO_SHOTS_MAX} ids of the ones ` +
        'that best show the change. Otherwise omit.',
    },
    offPlan: {
      type: 'array',
      items: { type: 'string' },
      description:
        `OMIT unless the delivered work materially differs from the mission description (something was cut, ` +
        `or done a different way). Then at most ${SHIPPED_OFF_PLAN_MAX_LINES} short plain lines, each saying what ` +
        'differs and why. A retry, a conflict or CI fix, a rename, or a different implementation with no effect ' +
        'on the outcome is not off-plan. When unsure, omit.',
    },
  },
  required: ['lede'],
} as const satisfies Record<string, unknown>;

/**
 * The instruction text appended to the two completion-proposing tasks. Built on
 * the PR lede rules (`LEDE_FIELD_SPEC`), relaxed to one or two sentences. The
 * two examples carry more than the rule does; keep them.
 */
export function shippedPromptText(trigger: 'planning' | 'evaluation'): string {
  const when = trigger === 'planning'
    ? 'When you set missionComplete'
    : 'When you return verdict "complete"';
  return [
    `${when}, also fill \`shipped\`.`,
    '',
    '`shipped.lede`: ONE or TWO plain sentences for the person who asked for this mission and',
    'has not read any of its pull requests: what is different for them now, and if the change',
    'was visual, whether anyone looked at it. Say it the way you would say it out loud to a',
    'colleague. No file paths, route or endpoint names, symbol or function names, class names,',
    'PR numbers, or internal vocabulary (task, handoff, criterion, cycle). Do not list what each',
    `task did; say what the whole mission changed. Max ${SHIPPED_LEDE_MAX_CHARS} characters.`,
    '',
    `\`shipped.heroShots\`: only if screenshots are listed below, up to ${SHIPPED_HERO_SHOTS_MAX} ids of the ones that`,
    'best show the change. Otherwise omit it.',
    '',
    '`shipped.offPlan`: OMIT THIS unless the delivered work materially differs from the mission',
    'description: something was cut, or something was done a different way than described.',
    `Then at most ${SHIPPED_OFF_PLAN_MAX_LINES} short plain lines, each saying what differs and why. A retry, a conflict or`,
    'CI fix, a rename, or a different implementation with no effect on the outcome is not',
    'off-plan. When unsure, omit it.',
    '',
    'BAD:  "Fixed mobile layout issue with ProviderOnboardingCard pushing Needs You content',
    '       below the fold. Added hasActionableWork prop and reduced mobile padding from',
    '       pb-16 to pb-8."',
    '      (A commit message: component, prop, classes. Nothing says how the phone looks now.)',
    'BAD:  "Root cause: the after-CI fix task for a release PR was an attempt whose parent was',
    '       the adopted release task, so closeAncestorRetryPrs treated it as an earlier',
    '       attempt. Added isEarlierAttemptPr; 8 new tests."',
    '      (A reviewer\'s narrative: root cause, symbols, test counts. The outcome for the',
    '       owner is never stated.)',
    'GOOD: "On a phone, the home screen now opens on what needs you instead of a setup card',
    '       that pushed it below the fold. Checked at phone and desktop width."',
    'GOOD: "Release pull requests are no longer closed by mistake when a follow-up fix fails.',
    '       One planned cleanup was dropped."',
  ].join('\n');
}

/**
 * The same contract, one task wide: a task that opens a PR may return
 * `shipped: { lede, offPlan? }` in its `complete_task` structured output, and
 * the completed task page leads with it. The server adds the change type from
 * the PR diff and checks the lede exactly as it does a mission's; a lede that
 * fails is not shown and the page falls back to the title. No hero shots: the
 * task page picks those from its own audit screenshots.
 */
export function taskShippedPromptText(): string {
  return [
    '## What shipped',
    'When you call `complete_task`, include `shipped` in `structuredOutput`:',
    '`{ shipped: { lede: "...", offPlan?: ["..."] } }`. The completed task page leads with it.',
    '',
    '`shipped.lede`: ONE or TWO plain sentences for the person who asked for this task and will',
    'not read the diff: what is different for them now, and if the change was visual, whether',
    'anyone looked at it. No file paths, route or endpoint names, symbol or function names, class',
    `names, PR numbers, or internal vocabulary. Max ${SHIPPED_LEDE_MAX_CHARS} characters. A lede that breaks these`,
    'rules is not shown.',
    '',
    '`shipped.offPlan`: OMIT unless what you delivered materially differs from the task description',
    `(something cut, or done a different way). Then at most ${SHIPPED_OFF_PLAN_MAX_LINES} short plain lines saying what and why.`,
    '',
    'BAD:  "Added TaskShippedHeader to page.tsx and a jsonb merge on tasks.result."',
    'GOOD: "A finished task now opens on a plain sentence about what changed, with the merge',
    '       button full width on a phone. Checked at phone and desktop width."',
  ].join('\n');
}

/**
 * The one-line outcome of a task, for prompts that list a mission's completed
 * work: the handoff's `delivered` line when there is one, else the summary.
 * A summary the runner captured at session end (`summarySource: 'fallback'`)
 * or the reaper extracted is never an outcome, so it yields null.
 */
export function taskOutcomeLine(result: unknown): { kind: 'handoff' | 'summary'; text: string } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as {
    summary?: unknown;
    summarySource?: unknown;
    reaperAutoCompleted?: unknown;
    structuredOutput?: { handoff?: Partial<TaskHandoff> } | null;
  };
  const delivered = r.structuredOutput?.handoff?.delivered;
  if (typeof delivered === 'string' && delivered.trim()) return { kind: 'handoff', text: delivered.trim() };
  if (typeof r.summary !== 'string' || !r.summary.trim()) return null;
  if (r.summarySource === 'fallback' || r.reaperAutoCompleted === true) return null;
  return { kind: 'summary', text: r.summary.trim() };
}
