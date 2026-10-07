/**
 * Heartbeat triage (docs/design/heartbeat-triage.md).
 *
 * A heartbeat cycle that survives the token-free prepass (heartbeat-prepass.ts)
 * dispatches the organizer: a full runner session that reads the heartbeat
 * context and, on most cycles, reports that the work in flight needs nothing
 * from it. This module asks a decision model (Jev) that one question first,
 * over a condensed copy of the same context the organizer would read:
 *
 *   - `wait`: nothing for the organizer to do this cycle;
 *   - `act`: the organizer must do something now.
 *
 * Only a confident `wait` changes anything, and only for a mission in the
 * treatment arm of the team's running `heartbeat_triage` experiment
 * (@buildd/core/heartbeat-triage-experiment): the cycle is deferred to the
 * schedule's next slot instead of dispatching. Outside an experiment, or in
 * its control arm, triage is shadow. `act`, low confidence, a failed call, no
 * key, a sensitive workspace or a stale organizer all dispatch as before.
 * Every look is a `heartbeat_triage_looks` row carrying the organizer task it
 * dispatched, so the organizer's own outcome on the same state grades it.
 *
 * Guards on a skip:
 *   - the no-change hash is restored, so the next tick triages again rather
 *     than reading "no change" and never waking the organizer on this state;
 *   - the organizer always runs when its last cycle is older than
 *     TRIAGE_MAX_WAIT_MS, so a wrong `wait` costs at most that long.
 *
 * Runs only when an OpenRouter key resolves for the team (server feature
 * `heartbeat_triage`, `inference-policy.ts`). A team without one, or with the
 * feature set to `runner`, keeps the organizer on every cycle.
 */
import { createHash } from 'node:crypto';
import { promptedQuestions } from '@buildd/core/prompted-decision';
import type { ChoiceQuestion, DecisionResult, decisionCall } from '@buildd/core/decision-client';
import { registerPromptedQuestions } from '@buildd/core/prompted-decision';

export const TRIAGE_TIMEOUT_MS = 4_000;
export const TRIAGE_LOG_PREFIX = '[heartbeat-triage]';
/** A `wait` below this confidence dispatches the organizer (an experiment's config may raise it). */
export const WAIT_MIN_CONFIDENCE = 0.9;
/** The organizer runs regardless when its last cycle is older than this. */
export const TRIAGE_MAX_WAIT_MS = 3 * 60 * 60_000;
/** Bump when the question, a definition or the state shape changes; re-run the benchmark. */
export const HEARTBEAT_TRIAGE_PROMPT_VERSION = 'ht1';
/** The prompts-table id whose active row may replace `HEARTBEAT_TRIAGE_QUESTIONS`. */
export const HEARTBEAT_TRIAGE_PROMPT_ID = 'buildd.heartbeat_triage';

export type TriageLabel = 'wait' | 'act';

export const HEARTBEAT_TRIAGE_QUESTIONS = {
  next: {
    type: 'choice',
    instructions: {
      question: 'This is a periodic check-in on a mission run by AI agents. Does the mission\'s organizer need to do anything this cycle?',
      rule: 'Judge from the tasks, pull requests, failures, questions and prior check-ins in the state. Work that is running, queued, in CI or in review needs nothing from the organizer.',
    },
    criteria: {
      wait: {
        what: 'Nothing to do this cycle: tasks are running or queued, pull requests are in CI or review or waiting on a human merge, or the mission is waiting on another mission, a budget reset or a reviewer. Recent check-ins found the same situation.',
        not_for: 'A task that failed with no retry queued, a question or guidance from the owner the organizer has not acted on, a deadlock, or goal criteria still unmet with no task active or pending.',
      },
      act: {
        what: 'The organizer must act now: file the next task, retry or replace a failed one, change the plan, act on the owner\'s guidance, break a deadlock, or cancel stuck work.',
        not_for: 'Restating progress, or re-proposing waits and monitoring for work already in flight.',
      },
    } satisfies Record<TriageLabel, { what: string; not_for: string }>,
  } satisfies ChoiceQuestion<TriageLabel>,
};

/**
 * Heartbeat-context sections Jev reads, by heading prefix. The mission's own
 * write-up, the checklist, artifacts, knowledge and workspace awareness are
 * left out: they describe the goal, not whether this cycle needs anything, and
 * accuracy falls as irrelevant state grows.
 */
const KEEP_SECTIONS: ReadonlyArray<{ prefix: string; maxChars: number; tail?: boolean }> = [
  { prefix: '## Mission Phase', maxChars: 600 },
  { prefix: '## Mission State', maxChars: 600 },
  { prefix: '## Goal criteria', maxChars: 1_200 },
  { prefix: '## User Guidance', maxChars: 1_000 },
  { prefix: '## Questions & Answers', maxChars: 1_000 },
  { prefix: '## Prior organizer runs', maxChars: 600 },
  // Pre-rename heading: stored descriptions the benchmark rebuilds from.
  { prefix: '## Prior Heartbeats', maxChars: 600 },
  { prefix: '## Active/Pending Tasks', maxChars: 1_500 },
  { prefix: '## Blocked Tasks', maxChars: 1_200 },
  { prefix: '## Failed Tasks', maxChars: 1_200 },
  { prefix: '## Pull Requests', maxChars: 1_200 },
  // Newest decisions and completions are last: keep the tail.
  { prefix: '## Recent Agent Decisions', maxChars: 1_200, tail: true },
  { prefix: '## Completed Tasks', maxChars: 1_500, tail: true },
];

function clip(text: string, max: number, tail = false): string {
  if (text.length <= max) return text;
  return tail ? `…${text.slice(text.length - max)}` : `${text.slice(0, max)}…`;
}

/**
 * The condensed state, from the heartbeat description `buildMissionContext`
 * rendered. Built from the text (not the rows) so the benchmark can rebuild it
 * from a past cycle's stored description exactly as the live call saw it.
 */
export function buildHeartbeatTriageState(description: string): string {
  const sections = new Map<string, string>();
  for (const block of `\n${description}`.split(/\n(?=## )/)) {
    const head = block.split('\n', 1)[0].trim();
    const keep = KEEP_SECTIONS.find(k => head.startsWith(k.prefix));
    if (!keep || sections.has(keep.prefix)) continue;
    const body = block.slice(block.indexOf('\n') + 1).trim();
    sections.set(keep.prefix, `${head}\n${clip(body, keep.maxChars, keep.tail)}`);
  }
  return KEEP_SECTIONS.map(k => sections.get(k.prefix)).filter(Boolean).join('\n\n');
}

/** Hash of the prompt, pinned by a test to HEARTBEAT_TRIAGE_PROMPT_VERSION. */
export function heartbeatTriagePromptHash(): string {
  return createHash('sha256').update(JSON.stringify(HEARTBEAT_TRIAGE_QUESTIONS)).digest('hex').slice(0, 12);
}

export interface HeartbeatTriageRecord {
  v: string;
  /** The model that answered (a team's decision model may not be Jev). */
  model?: string | null;
  pick: TriageLabel | null;
  confidence: number | null;
  /** True when this look skipped the organizer. */
  skipped: boolean;
  /** Why the look did not skip (or why there was no pick). */
  reason: 'act' | 'low_confidence' | 'shadow' | 'stale_organizer' | 'sensitive' | 'unavailable' | null;
  error?: string;
  latencyMs?: number;
  at: string;
}

export interface GateInput {
  pick: TriageLabel;
  confidence: number;
  apply: boolean;
  /** When the organizer last ran for this schedule. Null: never. */
  lastOrganizerAt: Date | null;
  now: Date;
  /** Default WAIT_MIN_CONFIDENCE. */
  waitMinConfidence?: number;
}

/** Skip the organizer this cycle? Pure. */
export function gateHeartbeatTriage(g: GateInput): { skip: boolean; reason: HeartbeatTriageRecord['reason'] } {
  if (g.pick !== 'wait') return { skip: false, reason: 'act' };
  if (g.confidence < (g.waitMinConfidence ?? WAIT_MIN_CONFIDENCE)) return { skip: false, reason: 'low_confidence' };
  if (!g.lastOrganizerAt || g.now.getTime() - g.lastOrganizerAt.getTime() > TRIAGE_MAX_WAIT_MS) {
    return { skip: false, reason: 'stale_organizer' };
  }
  if (!g.apply) return { skip: false, reason: 'shadow' };
  return { skip: true, reason: null };
}

export interface TriageInput {
  teamId: string;
  workspaceId: string | null;
  /** The heartbeat description `buildMissionContext` rendered for this cycle. */
  description: string;
  lastOrganizerAt: Date | null;
  /** `workspaces.dataClass`. Sensitive workspaces never send content out. */
  dataClass?: string | null;
  /** The mission is in the treatment arm: a confident wait may skip. Default false (shadow). */
  apply?: boolean;
  waitMinConfidence?: number;
}

type DecideFn = typeof decisionCall<typeof HEARTBEAT_TRIAGE_QUESTIONS>;

/** Decide one cycle. Never throws; any failure dispatches the organizer. */
export async function triageHeartbeat(
  input: TriageInput,
  deps: { decide?: DecideFn; now?: () => Date } = {},
): Promise<HeartbeatTriageRecord> {
  const now = (deps.now ?? (() => new Date()))();
  // The questions in effect: an active prompts row, else the public ones (@buildd/core/prompted-decision).
  const prompt = promptedQuestions(HEARTBEAT_TRIAGE_PROMPT_ID, HEARTBEAT_TRIAGE_QUESTIONS, HEARTBEAT_TRIAGE_PROMPT_VERSION);
  const base = { v: prompt.promptVersion, at: now.toISOString() };
  if (input.dataClass === 'sensitive') {
    return { ...base, pick: null, confidence: null, skipped: false, reason: 'sensitive' };
  }
  let result: DecisionResult<typeof HEARTBEAT_TRIAGE_QUESTIONS>;
  try {
    const decide = deps.decide ?? (await import('@buildd/core/decision-client')).decisionCall;
    result = await decide({
      capability: 'heartbeat_triage',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      state: buildHeartbeatTriageState(input.description),
      questions: prompt.questions,
      timeoutMs: TRIAGE_TIMEOUT_MS,
    });
  } catch (e) {
    return { ...base, pick: null, confidence: null, skipped: false, reason: 'unavailable', error: e instanceof Error ? e.message : String(e) };
  }
  if (!result.ok) {
    return { ...base, pick: null, confidence: null, skipped: false, reason: 'unavailable', error: result.error.kind, latencyMs: result.latencyMs };
  }
  const answer = result.answers.next;
  const gate = gateHeartbeatTriage({
    pick: answer.choice, confidence: answer.confidence,
    apply: input.apply ?? false, lastOrganizerAt: input.lastOrganizerAt, now,
    waitMinConfidence: input.waitMinConfidence,
  });
  return {
    ...base, model: result.model, pick: answer.choice, confidence: answer.confidence,
    skipped: gate.skip, reason: gate.reason, latencyMs: result.latencyMs,
  };
}

/** One log line per look, greppable in `vercel logs`. */
export function formatTriageLog(missionId: string, r: HeartbeatTriageRecord): string {
  const conf = r.confidence == null ? '-' : r.confidence.toFixed(2);
  return `${TRIAGE_LOG_PREFIX} mission=${missionId} v=${r.v} pick=${r.pick ?? '-'} conf=${conf} skipped=${r.skipped} reason=${r.reason ?? '-'}${r.error ? ` error=${r.error}` : ''}`;
}

/**
 * What the gate needs beyond the description: when this schedule last
 * dispatched the organizer (the cycle being decided is not inserted yet) and
 * the workspace's data class. Lookup failures read as "never" / unknown, which
 * dispatch the organizer.
 */
export async function loadHeartbeatTriageFacts(scheduleId: string, workspaceId: string | null): Promise<{ lastOrganizerAt: Date | null; dataClass: string | null }> {
  const { db } = await import('@buildd/core/db');
  const { tasks, workspaces } = await import('@buildd/core/db/schema');
  const { desc, eq } = await import('drizzle-orm');
  const [last, ws] = await Promise.all([
    db.query.tasks.findFirst({ where: eq(tasks.scheduleId, scheduleId), orderBy: [desc(tasks.createdAt)], columns: { createdAt: true } }).catch(() => null),
    workspaceId
      ? db.query.workspaces.findFirst({ where: eq(workspaces.id, workspaceId), columns: { dataClass: true } }).catch(() => null)
      : Promise.resolve(null),
  ]);
  return { lastOrganizerAt: last?.createdAt ?? null, dataClass: (ws?.dataClass as string | null | undefined) ?? null };
}

// Registered for the deploy seed and the fallback alert (`@buildd/core/prompts`).
registerPromptedQuestions(HEARTBEAT_TRIAGE_PROMPT_ID, HEARTBEAT_TRIAGE_QUESTIONS);
