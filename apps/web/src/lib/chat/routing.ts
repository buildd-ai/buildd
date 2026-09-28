/**
 * Per-turn tier and intent routing through a decision call
 * (docs/design/agent-chat.md → Models: tiers; docs/design/decision-calls.md).
 *
 * A decision call is only ever an accelerator in front of a fixed default: any
 * failure (disabled, no key, timeout, parse) or low confidence takes the safe
 * default — `standard` tier with the full read-plus-approval tool set. Routing
 * can pick a cheaper tier for a turn; it never changes which model backs one.
 */

import { gateChoice, type ChoiceQuestion, type DecisionResult, type DecisionUsage, decisionCall } from '@buildd/core/decision-client';
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
 * Asked only when the turn passes the conversation's auto title (see
 * `retitle.ts`): has the conversation moved on from what its title names?
 * Rides the routing call, so it costs a question, never a request.
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

/** An area answer is only used to *add* a tool group, so it's gated lower. */
export const AREA_MIN_CONFIDENCE = 0.7;
/**
 * A workspace pick becomes the turn's default scope for tool calls, so it's
 * gated high. Below it the turn has no default: the agent asks which one, or
 * the tool call names it, and reach still bounds what any call can touch.
 */
export const WORKSPACE_MIN_CONFIDENCE = 0.85;
/** A choice takes at most 255 labels (decision-client MAX_CHOICE_OPTIONS). */
const MAX_WORKSPACE_LABELS = 255;

/** A workspace the turn may be routed to, with what it's about (repo, projects). */
export interface RoutableWorkspace {
  id: string; name: string; hint?: string | null;
  /** Latest task activity (ISO), null = none in the lookback; spanning reads skip idle ones. */
  lastActiveAt?: string | null;
}

/**
 * What a workspace is about, for the workspace question: its repo's name and
 * its projects. `repo` is a URL (never interpolated whole); only the last path
 * segment is used. Pure; null when there's nothing to say.
 */
export function workspaceHint(ws: { repo?: string | null; projects?: ReadonlyArray<{ name: string; description?: string | null }> | null }): string | null {
  const parts: string[] = [];
  const repoName = ws.repo?.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop();
  if (repoName) parts.push(`repo ${repoName}`);
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
  /** The title-topic answer, ungated, when `title` was passed and the call answered it. */
  topic?: { label: 'same_topic' | 'new_topic'; confidence: number };
}

type RoutingQuestions = typeof CHAT_ROUTING_QUESTIONS & { workspace?: ChoiceQuestion<string>; topic?: typeof TITLE_TOPIC_QUESTION };
type Decide = (p: Parameters<typeof decisionCall<RoutingQuestions>>[0])
  => Promise<DecisionResult<RoutingQuestions>>;

export async function routeTurn(
  input: {
    teamId: string; workspaceId: string | null; userId: string; message: string; previous?: string;
    /** Unpinned conversations: the in-reach workspaces to pick the turn's scope from. */
    workspaces?: readonly RoutableWorkspace[];
    /** The conversation's auto title, to ask whether the conversation has moved on (`TITLE_TOPIC_QUESTION`). */
    title?: string;
  },
  deps: { decide?: Decide } = {},
): Promise<TurnRoute> {
  const fallback: TurnRoute = { tier: FALLBACK_TIER, allowWrites: true, source: 'fallback' };
  const decide = deps.decide ?? decisionCall<RoutingQuestions>;
  const ws = input.workspaces ? workspaceQuestion(input.workspaces) : null;
  const questions: RoutingQuestions = {
    ...CHAT_ROUTING_QUESTIONS,
    ...(ws ? { workspace: ws.question } : {}),
    ...(input.title ? { topic: TITLE_TOPIC_QUESTION } : {}),
  };
  let res: DecisionResult<RoutingQuestions>;
  try {
    res = await decide({
      capability: 'chat',
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      state: { turn: { message: input.message.slice(0, 2000), previous: (input.previous ?? '').slice(0, 1000), ...(input.title ? { title: input.title } : {}) } },
      questions,
      timeoutMs: ROUTING_TIMEOUT_MS,
    });
  } catch {
    return fallback;
  }
  if (!res.ok) return fallback;

  const tierGate = gateChoice(res.answers.complexity, TIER_MIN_CONFIDENCE);
  const intentGate = gateChoice(res.answers.intent, INTENT_MIN_CONFIDENCE);
  const areaGate = gateChoice(res.answers.area, AREA_MIN_CONFIDENCE);
  const area = areaGate.apply && areaGate.label !== 'general' ? areaGate.label : undefined;
  const wsAnswer = (res.answers as { workspace?: Parameters<typeof gateChoice>[0] }).workspace;
  const wsGate = ws && wsAnswer ? gateChoice(wsAnswer, WORKSPACE_MIN_CONFIDENCE) : null;
  const workspaceId = wsGate?.apply ? ws!.idFor.get(wsGate.label) : undefined;
  const topicAnswer = input.title ? (res.answers as { topic?: { choice?: unknown; confidence?: unknown } }).topic : undefined;
  const topic = topicAnswer && (topicAnswer.choice === 'same_topic' || topicAnswer.choice === 'new_topic') && typeof topicAnswer.confidence === 'number'
    ? { label: topicAnswer.choice, confidence: topicAnswer.confidence } as const
    : undefined;
  return {
    tier: tierGate.apply ? TIER_FOR[tierGate.label] : FALLBACK_TIER,
    // Withhold the write tools only on a confident "not acting"; low
    // confidence keeps them (the approval card is the backstop either way).
    allowWrites: !(intentGate.apply && intentGate.label !== 'act'),
    ...(area ? { area } : {}),
    source: tierGate.apply || intentGate.apply || areaGate.apply ? 'decision' : 'fallback',
    ...(res.usage ? { usage: res.usage } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    ...(topic ? { topic } : {}),
  };
}
