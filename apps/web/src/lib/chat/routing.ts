/**
 * Per-turn tier and intent routing through a decision call
 * (docs/design/agent-chat.md → Models: tiers; docs/design/decision-calls.md).
 *
 * A decision call is only ever an accelerator in front of a fixed default: any
 * failure (disabled, no key, timeout, parse) or low confidence takes the safe
 * default — `standard` tier with the full read-plus-approval tool set. Routing
 * can pick a cheaper tier for a turn; it never changes which model backs one.
 */

import { gateChoice, type ChoiceQuestion, type DecisionAccess, type DecisionError, type DecisionResult, type DecisionUsage, type GateOutcome, type UsageSink, decisionCall } from '@buildd/core/decision-client';
import type { ChatTier } from './models';
import type { ToolGroup } from './registry';

export const CHAT_ROUTING_QUESTIONS = {
  complexity: {
    type: 'choice',
    instructions: {
      question: 'How demanding is answering the latest user message in `turn.message`, given `turn.previous`?',
      rule: 'Follow the definitions. Length alone does not make a message complex.',
    },
    criteria: {
      simple: 'A greeting, thanks, a yes/no confirmation, or a one-fact lookup ("what\'s the status of X?") that needs no reasoning over several items.',
      standard: 'A normal question about work in flight, a summary of a few missions or tasks, or drafting one mission from a goal already discussed.',
      complex: 'Planning or comparing across many missions, tasks or trade-offs; shaping an ambiguous goal into criteria; or reasoning that must weigh conflicting evidence.',
    },
  } satisfies ChoiceQuestion<'simple' | 'standard' | 'complex'>,
  intent: {
    type: 'choice',
    instructions: {
      question: 'What does the user want done with the latest message in `turn.message`?',
      rule: 'Choose act only when the user asks to create, change or steer something now.',
    },
    criteria: {
      answer: 'Conversation that needs no buildd data: thanks, a clarification about what was just said, general advice.',
      needs_tools: 'A question answered from live buildd state: tasks, missions, schedules, artifacts, what is running or shipped.',
      act: 'A request to create, change or steer work now: "make this a mission", "pause checkout", "tell the agent to…", "drop that task", "schedule a sweep".',
    },
  } satisfies ChoiceQuestion<'answer' | 'needs_tools' | 'act'>,
  area: {
    type: 'choice',
    instructions: {
      question: 'Which area of buildd does the latest message in `turn.message` mostly concern?',
      rule: 'Pick the area whose tools would answer or carry out the request. Choose general when no single area fits.',
    },
    criteria: {
      missions: 'Missions or initiatives: goals, criteria, phases, holding or arming a mission, spec discrepancies.',
      tasks: 'Individual tasks: their status, creating, editing, cancelling or re-running one, plans awaiting approval.',
      workers: 'Running agents: steering or messaging one, a waiting question, why something failed or is stuck, fleet health, CI failures, budget.',
      prs: 'Pull requests, reviews, CI checks on a PR, and releases.',
      memory: 'Team knowledge: recalling what was decided or learned, saving a lesson.',
      schedules: 'Recurring work: creating, changing, pausing or tracing a schedule.',
      artifacts: 'Reports, analyses and other artifacts.',
      notifications: 'Being told later: "let me know when it merges", "tell me when checkout is done", or stopping or listing those watches.',
      admin: 'Workspace settings, roles/skills, experiments, watched projects, or triggering a release.',
      general: 'None of the above clearly, or several at once.',
    },
  } satisfies ChoiceQuestion<ToolGroup | 'general'>,
};

/**
 * Asked post-response to check whether the conversation has moved on from its auto title (see
 * `retitle.ts`). Made as a separate decision call after the response is saved, not during routing.
 */
export const TITLE_TOPIC_QUESTION = {
  type: 'choice',
  instructions: {
    question: 'Does the conversation title in `turn.title` still name what the latest message in `turn.message` is about?',
    rule: 'Choose new_topic only when the message starts a clearly different subject. A follow-up, a detail, a thank-you or a next step on the same work is same_topic.',
  },
  criteria: {
    same_topic: 'The message continues, narrows or follows up on the subject the title names, or is small talk.',
    new_topic: 'The message is about a different mission, task, system or goal than the title names.',
  },
} satisfies ChoiceQuestion<'same_topic' | 'new_topic'>;

/** Thresholds live next to the questions; retuning one is a reviewed change. */
export const TIER_MIN_CONFIDENCE = 0.8;
/** Only used to *withhold* write tools, so it's gated high. */
export const INTENT_MIN_CONFIDENCE = 0.9;
/**
 * Routing sits in front of the first token (target: under 2s at p50), so its
 * deadline is tight; a slow decision just means the default tier.
 */
export const ROUTING_TIMEOUT_MS = 900;
export const FALLBACK_TIER: ChatTier = 'standard';

const TIER_FOR: Record<'simple' | 'standard' | 'complex', ChatTier> = {
  simple: 'budget', standard: 'standard', complex: 'premium',
};

/**
 * An area answer narrows the tool set from the fallback (missions + tasks +
 * workers) to just the routed area. Narrowing saves ~1.7k tokens per turn
 * (routing costs are offset by the generative savings on the model side).
 * High gate ensures mis-routed turns that still need workers diagnostics
 * (stalled tasks, error investigation) don't lose access to them.
 */
export const AREA_MIN_CONFIDENCE = 0.8;
/**
 * A workspace pick becomes the turn's default scope for tool calls, so it's
 * gated high. Below it the turn has no default: the agent asks which one, or
 * the tool call names it, and reach still bounds what any call can touch.
 */
export const WORKSPACE_MIN_CONFIDENCE = 0.85;
/** A choice takes at most 255 labels (decision-client MAX_CHOICE_OPTIONS). */
const MAX_WORKSPACE_LABELS = 255;
/**
 * The workspace question lists at most this many (recently active) workspaces.
 * Every label carries its hint, so an uncapped list grows with the team and
 * becomes the call's largest question; a workspace past the cap is still
 * reached by naming it (`namedWorkspace`) or from a docked object.
 */
export const MAX_ASKED_WORKSPACES = 15;
/** Shorter names and terms match too much prose to decide a workspace alone. */
const MIN_TERM_LENGTH = 3;

/** A workspace the turn may be routed to, with what it's about (repo, projects). */
export interface RoutableWorkspace {
  id: string; name: string; hint?: string | null;
  /** Names that mean this workspace in a message: its name, repo name, project names. Absent ⇒ the name. */
  terms?: readonly string[];
  /** Latest task activity (ISO), null = none in the lookback; spanning reads skip idle ones. */
  lastActiveAt?: string | null;
}

function repoName(repo?: string | null): string | undefined {
  return repo?.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || undefined;
}

/** The names a message may use for a workspace: its name, repo name and project names. Pure. */
export function workspaceTerms(ws: { name: string; repo?: string | null; projects?: ReadonlyArray<{ name: string }> | null }): string[] {
  const terms = [ws.name, repoName(ws.repo), ...(ws.projects ?? []).map(p => p.name)]
    .map(t => t?.trim()).filter((t): t is string => !!t);
  return [...new Set(terms)];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The one workspace the message names by name, repo or project, else null.
 * Whole-word, case-insensitive. A match inside a longer match of another
 * workspace doesn't count ("buildd" inside "buildd-docs"); two workspaces
 * named is no match. Pure.
 */
export function namedWorkspace(message: string, workspaces: readonly RoutableWorkspace[]): string | null {
  const hits: { id: string; start: number; end: number }[] = [];
  for (const w of workspaces) {
    for (const term of w.terms ?? [w.name]) {
      if (term.length < MIN_TERM_LENGTH) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRe(term)}(?![\\p{L}\\p{N}_-])`, 'giu');
      for (const m of message.matchAll(re)) hits.push({ id: w.id, start: m.index!, end: m.index! + m[0].length });
    }
  }
  const kept = hits.filter(h => !hits.some(o => o.id !== h.id && o.start <= h.start && o.end >= h.end && o.end - o.start > h.end - h.start));
  const ids = new Set(kept.map(h => h.id));
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * The workspaces the workspace question lists: recently active ones, most
 * recent first, at most MAX_ASKED_WORKSPACES. Unknown activity (the lookup
 * failed) keeps the list's order. Pure.
 */
export function workspacesToAsk(workspaces: readonly RoutableWorkspace[]): RoutableWorkspace[] {
  if (workspaces.every(w => w.lastActiveAt === undefined)) return workspaces.slice(0, MAX_ASKED_WORKSPACES);
  return workspaces
    .filter(w => !!w.lastActiveAt)
    .sort((a, b) => b.lastActiveAt!.localeCompare(a.lastActiveAt!))
    .slice(0, MAX_ASKED_WORKSPACES);
}

/**
 * What a workspace is about, for the workspace question: its repo's name and
 * its projects. `repo` is a URL (never interpolated whole); only the last path
 * segment is used. Pure; null when there's nothing to say.
 */
export function workspaceHint(ws: { repo?: string | null; projects?: ReadonlyArray<{ name: string; description?: string | null }> | null }): string | null {
  const parts: string[] = [];
  const repo = repoName(ws.repo);
  if (repo) parts.push(`repo ${repo}`);
  const projects = (ws.projects ?? []).map(p => (p.description ? `${p.name} (${p.description})` : p.name)).filter(Boolean);
  if (projects.length) parts.push(`projects: ${projects.join('; ')}`);
  const hint = parts.join(' · ').slice(0, 240);
  return hint || null;
}

/**
 * The workspace question, over the conversation's in-reach workspaces. Labels
 * are the names (the model reads them); a name shared by two workspaces gets
 * its short id so each label maps back to exactly one. Null when there's
 * nothing to choose between. No catch-all label: "none of these" is low
 * confidence, which the gate handles.
 */
export function workspaceQuestion(workspaces: readonly RoutableWorkspace[]): { question: ChoiceQuestion<string>; idFor: Map<string, string> } | null {
  const list = workspaces.slice(0, MAX_WORKSPACE_LABELS);
  if (list.length < 2) return null;
  const count = new Map<string, number>();
  for (const w of list) count.set(w.name, (count.get(w.name) ?? 0) + 1);
  const idFor = new Map<string, string>();
  const criteria: Record<string, string> = {};
  for (const w of list) {
    const label = (count.get(w.name) ?? 0) > 1 ? `${w.name} (${w.id.slice(0, 8)})` : w.name;
    idFor.set(label, w.id);
    criteria[label] = w.hint ? `${w.name}: ${w.hint}` : w.name;
  }
  return {
    idFor,
    question: {
      type: 'choice',
      instructions: {
        question: 'Which workspace is the latest user message in `turn.message` about?',
        rule: 'Pick the workspace the user names or clearly means (its repo, product or project). Follow the definitions.',
      },
      criteria,
    },
  };
}

export interface TurnRoute {
  tier: ChatTier;
  /** Offer write tools at all this turn. */
  allowWrites: boolean;
  /** The tool group routing picked, when confident. Absent ⇒ the fallback groups. */
  area?: ToolGroup;
  source: 'decision' | 'fallback';
  /** What the routing decision call cost, when it answered. Metered with the turn. */
  usage?: DecisionUsage;
  /** The workspace routing picked for an unpinned conversation, when confident. */
  workspaceId?: string;
  /**
   * How `workspaceId` was settled: the docked object's workspace, one the
   * message names, the previous turn's (sticky), or the workspace question.
   */
  workspaceSource?: 'docked' | 'named' | 'sticky' | 'decision';
  /** What routing did, for the record (`RoutingRecord`). Absent on turns routing didn't run for. */
  routing?: RoutingRecord;
}

/** `ai_usage.kind` of the routing call's receipt (surface `decision`). */
export const ROUTING_DECISION_ID = 'chat_routing';

/**
 * How the routing call ended: some gate applied (`decision`, same rule as
 * `source`), it answered and nothing cleared a gate (`low_confidence`), or it
 * failed (`error:<DecisionError kind>`; `error:threw` for a throw, which
 * `decisionCall` never does).
 */
export type RoutingOutcome = 'decision' | 'low_confidence' | `error:${DecisionError['kind'] | 'threw'}`;

/**
 * One question's answer: the label (a workspace pick is recorded as its id),
 * its confidence, and whether routing acted on it. Null label/confidence: not
 * answered.
 */
export interface RoutingAnswerRecord { label: string | null; confidence: number | null; applied: boolean }

/**
 * A content-free record of one routing call: labels, numbers and ids only,
 * never message text, titles or workspace names. Persisted with the user
 * message (`usage.routing`) and logged as `[chat-routing] {json}`.
 */
export interface RoutingRecord {
  outcome: RoutingOutcome;
  latencyMs: number;
  attempts: number;
  /** Questions asked (3 base, or 2 with a pinned tier, + workspace). */
  questionCount: number;
  /** Workspaces offered to the workspace question (0 when not asked). */
  workspaceCount: number;
  /** Per question; empty when the call failed. */
  answers: Partial<Record<'complexity' | 'intent' | 'area' | 'workspace', RoutingAnswerRecord>>;
}

/** The one log line per routed turn. Never throws. */
export function logRoutingRecord(record: RoutingRecord, log: (line: string) => void = console.info): void {
  try { log(`[chat-routing] ${JSON.stringify(record)}`); } catch { /* a log line never fails a turn */ }
}

function answerRecord(gate: GateOutcome<string>, label: string | null | undefined = gate.label): RoutingAnswerRecord {
  return { label: label ?? null, confidence: gate.confidence ?? null, applied: gate.apply };
}


/** Longest message the acknowledgement fast path considers. */
const ACK_MAX_LENGTH = 40;
const ACK_WORD = String.raw`(?:thanks?(?: you)?(?: so much| a lot)?|thx|ty|cheers|ok(?:ay)?|k|kk|cool|great|nice|perfect|awesome|got it|sounds good|sure|yes|yep|yeah|yup|no|nope|hi|hello|hey|yo|morning|good (?:morning|afternoon|evening)|go (?:ahead|for it)|do it|please do|lgtm)`;
const ACK_RE = new RegExp(String.raw`^(?:${ACK_WORD}|\p{Extended_Pictographic}+)(?:[\s,.!]+(?:${ACK_WORD}|\p{Extended_Pictographic}+))*[\s.!]*$`, 'iu');

/**
 * A whole message that is only an acknowledgement or a greeting ("thanks",
 * "ok 👍", "hi"). Such a turn skips the routing call (`routeTurn`). Short and
 * anchored: "thanks, now pause checkout" is not one.
 */
export function isAcknowledgement(message: string): boolean {
  const m = message.trim();
  return m.length > 0 && m.length <= ACK_MAX_LENGTH && ACK_RE.test(m);
}

/**
 * Did the previous assistant turn offer to do something, so that "ok" / "yes"
 * may mean "go ahead"? Conservative on the side of keeping writes: a question
 * at the end, or an offer phrase anywhere.
 */
export function offeredAction(previous: string | null | undefined): boolean {
  const p = (previous ?? '').trim();
  if (!p) return false;
  return /\?\s*$/.test(p) || /\b(?:want me to|should I|shall I|would you like|I can|I could|do you want|let me know if)\b/i.test(p);
}

type RoutingQuestions = Omit<typeof CHAT_ROUTING_QUESTIONS, 'complexity'> & {
  complexity?: typeof CHAT_ROUTING_QUESTIONS.complexity; workspace?: ChoiceQuestion<string>;
};
type Decide = (p: Parameters<typeof decisionCall<RoutingQuestions>>[0])
  => Promise<DecisionResult<RoutingQuestions>>;
type TopicDecide = (p: Parameters<typeof decisionCall<{ topic: typeof TITLE_TOPIC_QUESTION }>>[0])
  => Promise<DecisionResult<{ topic: typeof TITLE_TOPIC_QUESTION }>>;

/**
 * Ask the topic question in a post-response call (made after the turn is saved,
 * in the `later` callback). Returns the answer ungated.
 */
export async function askTopicQuestion(
  input: {
    teamId: string; workspaceId: string | null; userId: string; message: string; title: string;
    /**
     * The decision policy and key, resolved ahead, so the whole `ROUTING_TIMEOUT_MS`
     * goes to the provider. Absent ⇒ resolved inside the call.
     */
    access?: Promise<DecisionAccess>;
  },
  deps: { decide?: TopicDecide } = {},
): Promise<{ label: 'same_topic' | 'new_topic'; confidence: number } | undefined> {
  const decide = deps.decide ?? decisionCall<{ topic: typeof TITLE_TOPIC_QUESTION }> as TopicDecide;
  let res: DecisionResult<{ topic: typeof TITLE_TOPIC_QUESTION }>;
  try {
    res = await decide({
      capability: 'chat',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      state: { turn: { message: input.message.slice(0, 2000), title: input.title } },
      questions: { topic: TITLE_TOPIC_QUESTION },
      timeoutMs: ROUTING_TIMEOUT_MS,
      ...(input.access ? { access: input.access } : {}),
    });
  } catch {
    return undefined;
  }
  if (!res.ok) return undefined;

  const topicAnswer = (res.answers as { topic?: { choice?: unknown; confidence?: unknown } }).topic;
  const topic = topicAnswer && (topicAnswer.choice === 'same_topic' || topicAnswer.choice === 'new_topic') && typeof topicAnswer.confidence === 'number'
    ? { label: topicAnswer.choice, confidence: topicAnswer.confidence } as const
    : undefined;
  return topic;
}

export async function routeTurn(
  input: {
    teamId: string; workspaceId: string | null; userId: string; message: string; previous?: string;
    /** Unpinned conversations: the in-reach workspaces to pick the turn's scope from. */
    workspaces?: readonly RoutableWorkspace[];
    /** The docked object's (entry.about / linked mission) workspace: it decides, no question. */
    impliedWorkspaceId?: string | null;
    /** The previous turn's routed workspace: the default unless the message names another. */
    previousWorkspaceId?: string | null;
    /** The conversation pins its tier: the complexity answer would be overwritten, so it isn't asked. */
    tierPinned?: boolean;
    /**
     * The decision policy and key, resolved ahead (`resolveDecisionAccess`), so
     * the whole `ROUTING_TIMEOUT_MS` goes to the provider. Absent ⇒ resolved
     * inside the call, inside the deadline.
     */
    access?: Promise<DecisionAccess>;
  },
  deps: {
    decide?: Decide;
    /** Receipt sink for the routing call (`ai_usage`, kind `ROUTING_DECISION_ID`). */
    onUsage?: UsageSink;
    now?: () => number;
  } = {},
): Promise<TurnRoute> {
  const settled = input.workspaces ? settleWorkspace(input, input.workspaces) : null;
  // An acknowledgement or greeting needs no reasoning and no tools beyond the
  // fallback set: the cheap tier, without a routing call. Writes stay offered
  // only when the previous turn offered something ("Shall I file it?" → "ok").
  if (isAcknowledgement(input.message)) {
    return { tier: 'budget', allowWrites: offeredAction(input.previous), source: 'fallback', ...settled };
  }
  const decide = deps.decide ?? decisionCall<RoutingQuestions>;
  const now = deps.now ?? (() => Date.now());
  // Asked only when nothing above settled it, and only over a bounded list.
  const ws = input.workspaces && !settled ? workspaceQuestion(workspacesToAsk(input.workspaces)) : null;
  const { complexity, ...base } = CHAT_ROUTING_QUESTIONS;
  const questions: RoutingQuestions = {
    ...(input.tierPinned ? {} : { complexity }),
    ...base,
    ...(ws ? { workspace: ws.question } : {}),
  };
  const shape = {
    questionCount: Object.keys(questions).length,
    workspaceCount: ws ? ws.idFor.size : 0,
  };
  const fallback = (routing: RoutingRecord): TurnRoute => ({ tier: FALLBACK_TIER, allowWrites: true, source: 'fallback', ...settled, routing });
  const started = now();
  let res: DecisionResult<RoutingQuestions>;
  try {
    res = await decide({
      capability: 'chat',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      state: { turn: { message: input.message.slice(0, 2000), previous: (input.previous ?? '').slice(0, 1000) } },
      questions,
      timeoutMs: ROUTING_TIMEOUT_MS,
      decisionId: ROUTING_DECISION_ID,
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      ...(input.access ? { access: input.access } : {}),
    });
  } catch {
    return fallback({ outcome: 'error:threw', latencyMs: now() - started, attempts: 0, ...shape, answers: {} });
  }
  const timing = {
    latencyMs: typeof res.latencyMs === 'number' ? res.latencyMs : now() - started,
    attempts: typeof res.attempts === 'number' ? res.attempts : 0,
  };
  if (!res.ok) return fallback({ outcome: `error:${res.error.kind}`, ...timing, ...shape, answers: {} });

  // Unanswered when not asked (a pinned tier): no answer, fallback tier.
  const tierGate = gateChoice(res.answers.complexity, TIER_MIN_CONFIDENCE);
  const intentGate = gateChoice(res.answers.intent, INTENT_MIN_CONFIDENCE);
  const areaGate = gateChoice(res.answers.area, AREA_MIN_CONFIDENCE);
  const area = areaGate.apply && areaGate.label !== 'general' ? areaGate.label : undefined;
  const wsAnswer = (res.answers as { workspace?: Parameters<typeof gateChoice>[0] }).workspace;
  const wsGate = ws && wsAnswer ? gateChoice(wsAnswer, WORKSPACE_MIN_CONFIDENCE) : null;
  const workspaceId = wsGate?.apply ? ws!.idFor.get(wsGate.label) : undefined;
  const source = tierGate.apply || intentGate.apply || areaGate.apply ? 'decision' : 'fallback';
  const answers: RoutingRecord['answers'] = {
    complexity: answerRecord(tierGate),
    intent: answerRecord(intentGate),
    area: answerRecord(areaGate),
    // The label is a workspace name: record the id it maps to instead.
    ...(ws ? { workspace: answerRecord(wsGate ?? { apply: false, reason: 'no_answer' }, wsGate?.label !== undefined ? ws.idFor.get(wsGate.label) ?? null : null) } : {}),
  };
  return {
    tier: tierGate.apply ? TIER_FOR[tierGate.label] : FALLBACK_TIER,
    // Withhold the write tools only on a confident "not acting"; low
    // confidence keeps them (the approval card is the backstop either way).
    allowWrites: !(intentGate.apply && intentGate.label !== 'act'),
    ...(area ? { area } : {}),
    source,
    ...(res.usage ? { usage: res.usage } : {}),
    ...(settled ?? (workspaceId ? { workspaceId, workspaceSource: 'decision' as const } : {})),
    routing: { outcome: source === 'decision' ? 'decision' : 'low_confidence', ...timing, ...shape, answers },
  };
}

/**
 * The turn's workspace without the decision call, in order: the docked
 * object's, the one the message names, the previous turn's. Each must be one
 * of the offered (in-reach) workspaces. Null ⇒ ask.
 */
function settleWorkspace(
  input: { message: string; impliedWorkspaceId?: string | null; previousWorkspaceId?: string | null },
  workspaces: readonly RoutableWorkspace[],
): Pick<TurnRoute, 'workspaceId' | 'workspaceSource'> | null {
  const offered = (id?: string | null) => !!id && workspaces.some(w => w.id === id);
  if (offered(input.impliedWorkspaceId)) return { workspaceId: input.impliedWorkspaceId!, workspaceSource: 'docked' };
  const named = namedWorkspace(input.message, workspaces);
  if (named) return { workspaceId: named, workspaceSource: 'named' };
  if (offered(input.previousWorkspaceId)) return { workspaceId: input.previousWorkspaceId!, workspaceSource: 'sticky' };
  return null;
}
