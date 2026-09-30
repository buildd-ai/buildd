/**
 * One chat turn: `POST /api/chat/[id]` (docs/design/agent-chat.md → P1).
 *
 * Order matters and is the point of this module:
 *  1. refuse before any model call (capability off, no key, over a limit), so
 *     a team without chat sees nothing change;
 *  2. a user message: route (tier + intent), resolve the model, save it;
 *     an assistant message: reconcile approval answers against storage — a
 *     replay, an edit or a lost race decides nothing and runs nothing;
 *  3. stream, persist the response message on end, ping other devices.
 */

import { randomUUID } from 'crypto';
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  consumeStream,
  isStepCount,
  streamText,
  toUIMessageStream,
  type LanguageModel,
  type ToolSet,
  type UIMessage,
} from 'ai';
import type { ActionContext } from '@buildd/core/mcp-tools';
import {
  CHAT_EVENT_PART_TYPE,
  encodeApprovalPreview,
  type ChatApprovalPreview,
  type ChatMessagePart,
  type ChatTurnEntry,
  type ChatTurnMetadata,
  type ChatTurnRequest,
  type ChatUnavailableReason,
  type ChatUsage,
} from '@buildd/shared';
import { reconcileApprovals, recordApprovalRequests, dbDecide, storeApprovalResult, isToolPart, type DecideFn } from './approvals';
import { renderChatContextBlock } from './context-block';
import { CHAT_INSTRUCTIONS } from './instructions';
import { routeTurn, askTopicQuestion, isAcknowledgement, logRoutingRecord, FALLBACK_TIER, type RoutableWorkspace, type RoutingRecord, type TurnRoute } from './routing';
import { resolveDecisionAccess, type DecisionAccess } from '@buildd/core/decision-client';
import { titleToCheck } from './retitle-policy';
import { resolveChatModel, turnCostUsd, type ChatPoolContext, type ChatTier, type ResolvedChatModel } from './models';
import { recordChatPoolAssignment } from '@buildd/core/tier-pool-source';
import { buildChatTools, CORE_GROUPS, effectiveClass, FALLBACK_GROUPS, groupOf, isAllowlistedSelfOp, needsApproval, toolNamesForGroups, type ChatToolDeps } from './tools';
import { chatReadRoutes } from './in-process-api';
import { loadDocked, renderDocked } from './docked';
import { buildPreview } from './previews';
import { ONE_CARD_PER_TURN_REASON } from '@builddai/ai-kit/chat/contract';
import { resolveTaskRef } from './targets';
import { opSpec, type ToolGroup } from './registry';
import { canSkipCard, contentInContext, toolOutputInHistory } from './permissions';
import { directivePart, proposeDirectiveCard, withDirectiveCard, type ChatDirectiveHooks } from './directives';
import { renderStandingRules } from '@buildd/core/chat-directives';
import { backfillSteps, createStepTracker, knownCalls, mergeStepParts, withThinkingSteps } from './thinking-steps';
import type { LimitVerdict } from './limits';
import {
  DEFAULT_TURN_TIMING, TURN_STOPPED_NOTE, USAGE_SETTLE_MS, settleWithin, withDeadlineWatchdog, withStoppedNote, wrapUpStep,
  type TurnTiming,
} from './turn-deadline';
import {
  HISTORY_LIMIT,
  insertMessage,
  loadMessages,
  pingConversation,
  updateMessage,
  type ConversationRow,
  type MessageRow,
} from './store';

export const MAX_STEPS = 8;
export { TURN_BUDGET_MS } from './turn-deadline';
export const MAX_USER_TEXT = 8_000;

export interface TurnUser {
  id: string;
  name: string | null;
  timeZone: string;
  teamRole: 'owner' | 'admin' | 'member';
}

export interface TurnDeps {
  now?: () => Date;
  /**
   * Tool groups this person set to "Allow" (permissions-store.ts). A write in
   * one may run without its card while no tool output is in context.
   */
  allowedToolGroups?: ReadonlySet<ToolGroup>;
  /**
   * Budget and rate limits (limits.checkChatLimits). Required: a turn that
   * passes has been admitted and counted, so there is no unmetered default.
   */
  limits: (args: { teamId: string; userId: string; now: Date }) => Promise<LimitVerdict>;
  route?: (input: Parameters<typeof routeTurn>[0]) => Promise<TurnRoute>;
  /**
   * The routing call's decision policy and key (`resolveDecisionAccess`),
   * started alongside the limits check. The route passes the team row it
   * already loaded, so this is no second team read.
   */
  routingAccess?: (scope: { teamId: string; workspaceId: string | null; userId: string }) => Promise<DecisionAccess>;
  resolveModel?: (opts: { tier: ChatTier; teamId: string; workspaceId: string | null; userId: string; pool?: ChatPoolContext }) => Promise<ResolvedChatModel>;
  /** Persist a tier-pool assignment for a saved assistant turn. */
  recordPoolAssignment?: typeof recordChatPoolAssignment;
  makeApi: ChatToolDeps['makeApi'];
  actionContext: ActionContext;
  /** Team memory for recall/learn (see ChatToolDeps.memory). */
  memory?: ChatToolDeps['memory'];
  /**
   * The action context and memory for a workspace routing picked this turn
   * (an unpinned conversation). Absent ⇒ `actionContext` / `memory` as given.
   */
  scopeFor?: (workspaceId: string) => { actionContext: ActionContext; memory?: ChatToolDeps['memory'] };
  decide?: DecideFn;
  /** Link a filed mission to this conversation (missions.conversation_id). */
  linkMission: (missionId: string) => Promise<void>;
  /** The mission this conversation filed, docked when the request docks nothing. */
  linkedMissionId?: () => Promise<string | null>;
  /** Scheduled after the response (Next `after()`); runs inline in tests. */
  later?: (fn: () => Promise<void>) => void;
  /** `about`: the object the chat was opened on (entry.about), whose name can be the title. */
  autoTitle?: (conversation: ConversationRow, messages: UIMessage[], model: ResolvedChatModel & { ok: true }, about: { kind: 'mission' | 'task'; title: string } | null) => Promise<void>;
  /** Ask the title-topic question in a post-response call (chat/routing.ts). */
  askTopicQuestion?: typeof askTopicQuestion;
  /** Handle the title-topic answer and potentially retitle the conversation (chat/retitle.ts). */
  retitle?: (conversation: ConversationRow, messages: UIMessage[], topic: { label: 'same_topic' | 'new_topic'; confidence: number }) => Promise<void>;
  /** Test seam: replace the streamText call. */
  streamTextImpl?: typeof streamText;
  /** Test seam: the turn's wall clock (turn-deadline.ts). */
  timing?: Partial<TurnTiming>;
  /**
   * The person's standing rules (./directives.ts): loaded into the
   * instructions, and a confirm card when the user message states a new one.
   * Absent: neither.
   */
  directives?: ChatDirectiveHooks;
}

export function unavailable(reason: ChatUnavailableReason, status: number, extra: Record<string, unknown> = {}): Response {
  const message: Record<ChatUnavailableReason, string> = {
    no_key: 'No provider key is connected for chat. An admin can add a team key, or you can use your own.',
    budget_exhausted: 'Today\'s chat budget is used up. It resets at midnight in the team\'s timezone, and a team owner or admin can raise it. The mission form still works.',
    rate_limited: 'Too many chat turns in the last few minutes. Try again shortly.',
  };
  return Response.json({ error: reason, message: message[reason], ...extra }, { status });
}

/** Stored rows → UI messages for the model. Event rows become short assistant notes. */
/** Stored rows a turn loads; hitting it means older rows went unseen. */
const STORED_MESSAGE_LIMIT = 500;

export function toUiHistory(rows: MessageRow[]): UIMessage[] {
  const out: UIMessage[] = [];
  for (const m of rows.slice(-HISTORY_LIMIT)) {
    if (m.role === 'event') {
      const data = (m.parts.find(p => p.type === CHAT_EVENT_PART_TYPE) as { data?: { text?: string } } | undefined)?.data;
      if (data?.text) out.push({ id: m.id, role: 'assistant', parts: [{ type: 'text', text: `[update] ${data.text}` }] });
      continue;
    }
    const parts = m.parts.filter(p => p.type === 'text' || p.type === 'step-start' || p.type === 'reasoning' || isToolPart(p));
    if (parts.length > 0) out.push({ id: m.id, role: m.role, parts } as UIMessage);
  }
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client's `entry` (how the chat was opened), reduced to known values.
 * It only shapes the context block; the tools' reach checks still decide what
 * the model can read, so an id outside the conversation's team reads nothing.
 */
export function turnEntry(raw: unknown): ChatTurnEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { intent?: unknown; about?: unknown };
  const intent = r.intent === 'mission' || r.intent === 'task' ? r.intent : null;
  const a = r.about as { kind?: unknown; id?: unknown } | null | undefined;
  const about = a && (a.kind === 'mission' || a.kind === 'task') && typeof a.id === 'string' && UUID_RE.test(a.id)
    ? { kind: a.kind as 'mission' | 'task', id: a.id }
    : null;
  return intent || about ? { intent, about } : null;
}

/**
 * The user message's `usage`: the routing call's spend plus its record under
 * `routing` (jsonb, no migration). A call that failed spent nothing, so the
 * record rides on zero tokens with a null cost, which the budget sums skip.
 */
export function userTurnUsage(route: Pick<TurnRoute, 'usage' | 'routing'>): (ChatUsage & { routing?: RoutingRecord }) | null {
  if (!route.routing) return route.usage ?? null;
  return { ...(route.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null }), routing: route.routing };
}

function userTurnUsageRouted(route: Pick<TurnRoute, 'usage' | 'routing'>, routedWorkspaceId?: string): ReturnType<typeof userTurnUsage> {
  const usage = userTurnUsage(route);
  if (!routedWorkspaceId) return usage;
  return { ...(usage ?? { inputTokens: 0, outputTokens: 0, costUsd: null }), routedWorkspaceId };
}

function userText(message: ChatTurnRequest['message']): string | null {
  const texts = message.parts.filter(p => p.type === 'text').map(p => String((p as { text?: unknown }).text ?? ''));
  const text = texts.join('\n').trim();
  return text && text.length <= MAX_USER_TEXT ? text : null;
}

export async function runChatTurn(args: {
  conversation: ConversationRow;
  /** The conversation's pinned workspace, when it's in reach. Null = all workspaces. */
  workspace: { id: string; name: string } | null;
  /**
   * Unpinned: the in-reach workspaces. Routing may pick one per turn from the
   * message (routing.ts, confidence-gated); otherwise the turn has no default.
   */
  workspaces?: readonly RoutableWorkspace[];
  user: TurnUser;
  body: ChatTurnRequest;
  deps: TurnDeps;
}): Promise<Response> {
  const { conversation: conv, user, body, deps } = args;
  const now = deps.now?.() ?? new Date();
  // The wall clock starts here, not at the model call: everything before it
  // (limits, routing, docked reads) runs inside the same maxDuration.
  const turnStartedAt = Date.now();
  const timing: TurnTiming = { ...DEFAULT_TURN_TIMING, ...deps.timing };
  const deadlineAt = turnStartedAt + timing.budgetMs;

  const message = body?.message;
  if (!message || (message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.parts)) {
    return Response.json({ error: 'message with role and parts is required' }, { status: 400 });
  }

  const text = message.role === 'user' ? userText(message) : null;
  if (message.role === 'user' && !text) {
    return Response.json({ error: `a text message of 1–${MAX_USER_TEXT} characters is required` }, { status: 400 });
  }
  // Limits (budget, then atomic admission), history and the routing call's
  // policy + key lookup run in parallel: the lookup spends nothing, and doing it
  // here leaves routing's whole deadline to the provider. The routing call
  // itself waits for the verdict: it is metered spend too, so a refused turn
  // spends nothing. An acknowledgement skips the routing call (routing.ts), so
  // it needs no key.
  const routingAccess = text && !isAcknowledgement(text)
    ? (deps.routingAccess ?? (s => resolveDecisionAccess({ capability: 'chat', ...s })))({
      teamId: conv.teamId, workspaceId: args.workspace?.id ?? null, userId: user.id,
    }).catch((): DecisionAccess => ({ ok: false, error: { kind: 'missing_key' } }))
    : undefined;
  const [verdict, stored] = await Promise.all([
    deps.limits({ teamId: conv.teamId, userId: user.id, now }),
    loadMessages(conv.id, STORED_MESSAGE_LIMIT),
  ]);
  const entry = turnEntry(body.entry);
  // Reads for the docked object and for approval cards: every chat GET, still
  // reach-guarded, never a write route. The docked object loads alongside the
  // limits: its workspace settles an unpinned turn's scope without asking.
  const read = deps.makeApi(() => {}, { routes: chatReadRoutes() });
  const dockedPromise = (async () => {
    const linkedMissionId = entry?.about ? null : await (deps.linkedMissionId?.() ?? Promise.resolve(null)).catch(() => null);
    return loadDocked(read, entry?.about ?? null, linkedMissionId);
  })();
  // The person's rules load alongside everything else; never fails the turn.
  const rulesPromise = deps.directives ? deps.directives.load().catch(() => []) : Promise.resolve([]);
  if (!verdict.ok) {
    return unavailable(verdict.reason, 429, {
      message: verdict.message,
      retryAfterSeconds: verdict.retryAfterSeconds,
      ...(verdict.scope ? { scope: verdict.scope } : {}),
    });
  }
  const routable = args.workspace ? undefined : args.workspaces;
  const routeWorkspaces = routable && routable.length > 1 ? routable : undefined;
  const checkTitle = text && deps.retitle ? titleToCheck(conv, stored.filter(m => m.role === 'user').length + 1) : null;
  const lastAssistantMsg = lastAssistantText(stored);
  const routePromise = text
    ? (async () => {
      // Only an unpinned turn choosing between workspaces waits on the dock.
      const impliedWorkspaceId = routeWorkspaces ? (await dockedPromise)?.workspaceId ?? null : null;
      const previousWorkspaceId = routeWorkspaces ? lastRoutedWorkspaceId(stored) : null;
      return (deps.route ?? routeTurn)({
        teamId: conv.teamId, workspaceId: args.workspace?.id ?? null, userId: user.id, message: text,
        ...(lastAssistantMsg ? { previous: lastAssistantMsg } : {}),
        ...(routeWorkspaces ? { workspaces: routeWorkspaces } : {}),
        ...(impliedWorkspaceId ? { impliedWorkspaceId } : {}),
        ...(previousWorkspaceId ? { previousWorkspaceId } : {}),
        // A pinned tier overwrites routing's pick below, so it isn't asked.
        ...(conv.tier ? { tierPinned: true } : {}),
        ...(routingAccess ? { access: routingAccess } : {}),
      });
    })()
    : null;

  const history = toUiHistory(stored);
  // The "Allow" taint covers the whole stored conversation, not only the
  // HISTORY_LIMIT window the model is sent this turn.
  const historyTainted = toolOutputInHistory(stored, stored.length >= STORED_MESSAGE_LIMIT);
  const resolveModel = deps.resolveModel ?? resolveChatModel;
  let route: TurnRoute;
  let authorizedToolCallIds = new Set<string>();
  let approvedPreviews = new Map<string, ChatApprovalPreview>();
  let continuing: MessageRow | null = null;

  if (message.role === 'user') {
    route = await routePromise!;
    if (route.routing) logRoutingRecord(route.routing);
    // A tier the person pinned for this conversation wins over routing's pick.
    if (conv.tier) route = { ...route, tier: conv.tier };
  } else {
    // An approval answer: it must extend the latest stored assistant message.
    const last = stored.filter(m => m.role === 'assistant').at(-1);
    if (!last || last.id !== message.id) return Response.json({ error: 'approval_not_pending' }, { status: 409 });
    const r = await reconcileApprovals(last.parts, message.parts, deps.decide ?? dbDecide(conv.id, user.id));
    if (r.decided === 0) return Response.json({ error: 'approval_not_pending' }, { status: 409 });
    authorizedToolCallIds = r.authorizedToolCallIds;
    approvedPreviews = r.approvedPreviews;
    continuing = { ...last, parts: r.parts };
    await updateMessage(last.id, conv.id, { parts: r.parts });
    route = { tier: (last.tier as ChatTier) || FALLBACK_TIER, allowWrites: true, source: 'fallback' };
    // Keep the scope the card was built in, so the rebuilt card matches it.
    const cardWs = [...approvedPreviews.values()].map(p => p.target.workspaceId).find(id => !!id);
    if (cardWs) route = { ...route, workspaceId: cardWs };
  }

  // The turn's scope: the pin, else the workspace routing picked (only one in reach).
  const routedWs = !args.workspace && route.workspaceId
    ? (args.workspaces ?? []).find(w => w.id === route.workspaceId) ?? null
    : null;
  const scopeWs: { id: string; name: string; source: 'pinned' | 'routed' } | null = args.workspace
    ? { id: args.workspace.id, name: args.workspace.name, source: 'pinned' }
    : routedWs ? { id: routedWs.id, name: routedWs.name, source: 'routed' } : null;
  const scoped = routedWs && deps.scopeFor ? deps.scopeFor(routedWs.id) : null;
  const actionContext = scoped?.actionContext ?? deps.actionContext;
  const memory = scoped?.memory ?? deps.memory;

  // 2. A model for the tier, on the caller's key, else the workspace's, else the team's.
  // The tier's chat pool may enrol the turn (docs/design/tier-model-pools.md):
  // a turn continuing the previous turn's chain keeps its arm.
  const prevAssistant = stored.filter(m => m.role === 'assistant').at(-1);
  const pool: ChatPoolContext = {
    conversationId: conv.id,
    drawKey: `${conv.id}#${stored.length}`,
    previous: prevAssistant ? { id: prevAssistant.id, tier: prevAssistant.tier ?? null, createdAt: new Date(prevAssistant.createdAt) } : null,
    now,
  };
  const modelWs = scopeWs?.id ?? null;
  let model = await resolveModel({ tier: route.tier, teamId: conv.teamId, workspaceId: modelWs, userId: user.id, pool });
  if (!model.ok && route.tier !== FALLBACK_TIER) {
    model = await resolveModel({ tier: FALLBACK_TIER, teamId: conv.teamId, workspaceId: modelWs, userId: user.id, pool });
  }
  if (!model.ok) return unavailable('no_key', 409, { provider: model.provider });
  const resolved = model;

  // A rule stated in this message: its card is proposed off the critical path
  // and lands just before the stream finishes (./directives.ts). Only once the
  // turn has a model, so a refused turn spends no decision call.
  const directiveCard = message.role === 'user' && deps.directives
    ? proposeDirectiveCard({
      conversationId: conv.id,
      message: text!,
      previous: lastAssistantMsg,
      workspace: scopeWs ? { id: scopeWs.id, name: scopeWs.name, hint: routedWs?.hint ?? null } : null,
      judge: deps.directives.judge,
    })
    : null;
  const standingRules = await rulesPromise;

  let uiMessages: UIMessage[];
  if (message.role === 'user') {
    const saved = await insertMessage({
      conversationId: conv.id, role: 'user', authorUserId: user.id,
      parts: [{ type: 'text', text: text! }],
      // The routing decision call's spend, so the daily budget counts it, and
      // its content-free record (a failed call spent nothing: zero, cost null),
      // and the routed workspace, so the next turn can carry it over.
      usage: userTurnUsageRouted(route, routedWs?.id),
    });
    void pingConversation(conv.id, 'message', saved.id);
    uiMessages = [...history, { id: saved.id, role: 'user', parts: [{ type: 'text', text: text! }] }];
  } else {
    uiMessages = history.map(m => (m.id === continuing!.id ? { ...m, parts: continuing!.parts } as UIMessage : m));
  }

  const canAdmin = user.teamRole === 'owner' || user.teamRole === 'admin';
  const docked = await dockedPromise;
  const previewEnv = {
    read,
    scope: { missionId: docked?.missionId ?? null, missionTitle: docked?.missionTitle ?? null, workspaceId: scopeWs?.id ?? null },
  };
  const preview = (tool: string, input: Record<string, unknown>) => {
    const s = opSpec(tool, input);
    const admin = !!s && effectiveClass(tool, s.op, s.spec, input) === 'admin';
    return buildPreview(tool, input, previewEnv, { confirmAdmin: admin });
  };

  // Writes that run without a card this turn (the person's "Allow"; see below).
  const allowedToolCallIds = new Set<string>();
  const tools: ToolSet = buildChatTools({
    ctx: actionContext,
    makeApi: deps.makeApi,
    allowWrites: route.allowWrites,
    canAdmin,
    authorizedToolCallIds,
    allowedToolCallIds,
    approvedPreviews,
    preview,
    resolveTask: ref => resolveTaskRef(read, ref, previewEnv.scope),
    conversationId: conv.id,
    memory,
    // Filed tasks and missions carry the person's applicable rules.
    standingRules,
    // Unscoped: scoped reads span these rather than ask which workspace.
    ...(!scopeWs && args.workspaces ? { workspaces: args.workspaces } : {}),
    now: () => now.getTime(),
    onMissionFiled: async ({ missionId, toolCallId, result }) => {
      await deps.linkMission(missionId);
      await storeApprovalResult(toolCallId, conv.id, result).catch(() => {});
    },
  });
  const activeTools = toolNamesForGroups(tools, turnGroups({
    route, continuing, canAdmin, dockGroups: docked ? ['missions', 'tasks', 'workers'] : [],
  }));

  let approvalsThisTurn = 0;
  let allowedThisTurn = 0;
  const allowedGroups = deps.allowedToolGroups ?? new Set<ToolGroup>();
  const toolApproval = Object.fromEntries(Object.keys(tools).map(name => [
    name,
    async (input: unknown, options?: { toolCallId?: string; messages?: Parameters<typeof contentInContext>[0] }) => {
      const tainted = historyTainted || contentInContext(options?.messages ?? []);
      if (!needsApproval(name, input)) {
        // Reads run. An allowlisted self-scoped op (unwatch) runs without its
        // card too, unless tool output is in context: then it asks, like any write.
        if (!isAllowlistedSelfOp(name, input) || !tainted) return 'not-applicable' as const;
      } else if (allowedThisTurn === 0 && options?.toolCallId && canSkipCard({
        // The person's "Allow": one write per turn, only while nothing a tool
        // returned is in the model's context, and only with a preview that
        // resolves inside reach. Anything else falls through to the card.
        tool: name, input, allowedGroups, tainted,
        docked: docked !== null,
      })) {
        const p = await preview(name, (input ?? {}) as Record<string, unknown>).catch(() => null);
        if (p?.ok) {
          allowedThisTurn += 1;
          allowedToolCallIds.add(options.toolCallId);
          return 'not-applicable' as const;
        }
      }
      // At most one approval card per turn; a second write waits. The kit's
      // reason, so the card reads "not proposed", never "discarded".
      if (approvalsThisTurn >= 1) {
        return { type: 'denied' as const, reason: ONE_CARD_PER_TURN_REASON };
      }
      // The card says exactly what changes, from current state. A target that
      // isn't exactly one thing gets no card: the tool answers with a question.
      const p = await preview(name, (input ?? {}) as Record<string, unknown>).catch(() => null);
      if (p && !p.ok) return 'not-applicable' as const;
      approvalsThisTurn += 1;
      return p?.ok
        ? { type: 'user-approval' as const, reason: encodeApprovalPreview(p.preview) }
        : 'user-approval' as const;
    },
  ]));
  const dockedBlock = docked ? `\n\n${renderDocked(docked)}` : '';
  const instructions = `${CHAT_INSTRUCTIONS}\n\n${renderChatContextBlock({
    now,
    timeZone: user.timeZone,
    conversationId: conv.id,
    workspace: scopeWs,
    ...(!scopeWs && args.workspaces ? { workspaces: args.workspaces } : {}),
    user: { name: user.name, teamRole: user.teamRole, isOperator: user.teamRole !== 'member' },
    tier: resolved.tier,
    budgetWarning: verdict.budgetWarning,
    entry,
  })}${dockedBlock}${rulesBlock(standingRules, scopeWs?.id ?? null)}`;

  const startedAt = Date.now();
  let wrappedUp = false;
  let watchdogFired = false;
  const result = (deps.streamTextImpl ?? streamText)({
    model: resolved.model as LanguageModel,
    instructions,
    messages: await convertToModelMessages(uiMessages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    // Only this turn's groups are sent to the model; every tool stays defined,
    // so an approved call from an earlier turn still executes.
    activeTools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: AbortSignal.timeout(Math.max(1, deadlineAt - Date.now())),
    // Past the wrap-up mark a step gets no tools and is told to answer, so a
    // slow turn ends with an answer instead of being cut off mid-thought.
    prepareStep: ({ stepNumber }) => {
      const step = wrapUpStep({ stepNumber, elapsedMs: Date.now() - turnStartedAt, wrapUpMs: timing.wrapUpMs, instructions });
      if (step && !wrappedUp) {
        wrappedUp = true;
        console.warn(`[chat] turn wrap-up: conversation ${conv.id}, step ${stepNumber}, ${Date.now() - turnStartedAt}ms in, tier ${resolved.tier}, model ${resolved.modelId}`);
      }
      return step;
    },
    toolApproval,
  });
  // The abort only stops what honours it. A tool or provider stream that
  // doesn't would keep the turn open until the platform kills the function,
  // with nothing saved; the watchdog ends the stream so onEnd still runs.
  const modelStream = withDeadlineWatchdog(result.stream, deadlineAt + timing.graceMs, () => {
    watchdogFired = true;
    console.error(`[chat] turn watchdog fired: conversation ${conv.id} ignored its abort for ${timing.graceMs}ms past the deadline (tier ${resolved.tier}, model ${resolved.modelId})`);
  });

  const turnMetadata: ChatTurnMetadata = { tier: resolved.tier, scope: scopeWs };
  // The Thinking panel's steps, from the tool lifecycle (./thinking-steps.ts).
  // A continuation of a message saved before steps existed gets them first.
  const backfill = continuing ? backfillSteps(continuing.parts) : [];
  const steps = createStepTracker({ known: continuing ? knownCalls(continuing.parts) : [], seed: backfill });
  const stream = withStoppedNote(withDirectiveCard(withThinkingSteps(toUIMessageStream({
    stream: modelStream as typeof result.stream,
    tools,
    originalMessages: uiMessages,
    generateMessageId: () => randomUUID(),
    // The composer shows the turn's tier and scope ("→ billing-web") from this.
    messageMetadata: ({ part }) => (part.type === 'start' ? turnMetadata : undefined),
    onEnd: async ({ responseMessage, isContinuation, isAborted }) => {
      try {
        let parts = [...(responseMessage.parts as ChatMessagePart[])];
        if (isAborted) {
          parts.push({ type: 'text', text: TURN_STOPPED_NOTE });
          // One line per stopped turn, so this failure is countable in the logs.
          const toolCalls = parts.filter(p => typeof p.type === 'string' && p.type.startsWith('tool-')).length;
          console.warn(`[chat] turn hit its time limit: ${JSON.stringify({
            conversationId: conv.id, tier: resolved.tier, model: resolved.modelId,
            elapsedMs: Date.now() - turnStartedAt, budgetMs: timing.budgetMs,
            steps: parts.filter(p => p.type === 'step-start').length, toolCalls, wrappedUp, watchdog: watchdogFired,
          })}`);
        }
        const card = directiveCard ? await directiveCard : null;
        if (card) parts.push(directivePart(card));
        let usage: ChatUsage | null = null;
        try {
          // A stream the watchdog ended never reports usage: don't wait on it.
          const settleMs = watchdogFired ? 0 : USAGE_SETTLE_MS;
          const [u, metaRaw, stepResults] = await Promise.all([
            settleWithin(result.usage, settleMs),
            settleWithin(result.providerMetadata, settleMs),
            settleWithin(result.steps, settleMs),
          ]);
          const meta = metaRaw as Record<string, unknown> | undefined;
          usage = {
            inputTokens: u?.inputTokens ?? 0,
            outputTokens: u?.outputTokens ?? 0,
            costUsd: turnCostUsd(resolved.modelId, u, meta, stepResults),
            latencyMs: Date.now() - startedAt,
          };
        } catch { /* aborted streams may have no usage */ }
        // The steps were added downstream of this stream, so its message lacks
        // them; read the tracker last, once those chunks have passed through.
        parts = mergeStepParts(parts, steps.steps());

        const messageId = isContinuation && continuing ? continuing.id : responseMessage.id;
        if (isContinuation && continuing) {
          const prior = continuing.usage;
          await updateMessage(messageId, conv.id, {
            parts,
            usage: usage && prior ? {
              inputTokens: prior.inputTokens + usage.inputTokens,
              outputTokens: prior.outputTokens + usage.outputTokens,
              costUsd: (prior.costUsd ?? 0) + (usage.costUsd ?? 0),
              // Time to the reply the user first saw, not the approval resume.
              ...(prior.latencyMs != null ? { latencyMs: prior.latencyMs } : {}),
            } : usage ?? prior ?? null,
            model: resolved.modelId,
          });
        } else {
          await insertMessage({
            id: messageId, conversationId: conv.id, role: 'assistant', parts,
            tier: resolved.tier, model: resolved.modelId, usage,
          });
          // A continuation extends a turn that already has its row.
          if (resolved.pool) await (deps.recordPoolAssignment ?? recordChatPoolAssignment)(resolved.pool, { messageId });
        }
        await recordApprovalRequests({ conversationId: conv.id, messageId, userId: user.id, parts });
        await pingConversation(conv.id, 'message', messageId);

        const later = deps.later ?? (fn => void fn());
        const done = () => [...uiMessages, { ...responseMessage, parts } as UIMessage];
        if (!conv.title && message.role === 'user' && deps.autoTitle) {
          const about = entry?.about && docked?.kind === entry.about.kind && docked.id === entry.about.id
            ? { kind: docked.kind, title: docked.title }
            : null;
          const messages = done();
          later(() => deps.autoTitle!(conv, messages, resolved, about));
        } else if (text && !isAcknowledgement(text) && checkTitle && deps.retitle) {
          const messages = done();
          later(async () => {
            const topic = await (deps.askTopicQuestion ?? askTopicQuestion)({
              teamId: conv.teamId, workspaceId: args.workspace?.id ?? null, userId: user.id,
              message: text!, title: checkTitle,
              ...(routingAccess ? { access: routingAccess } : {}),
            });
            if (topic) await deps.retitle!(conv, messages, topic);
          });
        }
      } catch (e) {
        console.error(`[chat] failed to persist turn for conversation ${conv.id}:`, e);
      }
    },
  }), { tracker: steps, backfill }), directiveCard));

  return createUIMessageStreamResponse({
    stream,
    // Keep consuming if the client disconnects, so onEnd still saves the turn.
    consumeSseStream: ({ stream: s }) => consumeStream({ stream: s }),
    headers: { 'x-buildd-chat-tier': resolved.tier },
  });
}

/** The standing-rules block for the instructions, or '' (no rules). */
function rulesBlock(rules: Parameters<typeof renderStandingRules>[0], workspaceId: string | null): string {
  const block = renderStandingRules(rules, { workspaceId });
  return block ? `\n\n${block}` : '';
}

/** The workspace the latest user turn was routed to, for sticky routing. */
function lastRoutedWorkspaceId(stored: MessageRow[]): string | null {
  return stored.filter(m => m.role === 'user').at(-1)?.usage?.routedWorkspaceId ?? null;
}

/** The latest assistant reply's text, as context for the chat-tier question. */
function lastAssistantText(stored: MessageRow[]): string | null {
  const last = stored.filter(m => m.role === 'assistant').at(-1);
  if (!last) return null;
  const t = last.parts.filter(p => p.type === 'text').map(p => String((p as { text?: unknown }).text ?? '')).join('\n').trim();
  return t || null;
}

/**
 * Which tool groups this turn sends to the model (docs/design/agent-chat.md →
 * Tool groups): the core groups, plus the area routing named when confident,
 * else the fallback set. Admin tools only for an owner/admin. A continuation
 * adds the groups of the tools it's answering, so the approved call's tool is
 * active.
 */
export function turnGroups(args: {
  route: TurnRoute;
  continuing: MessageRow | null;
  canAdmin: boolean;
  /** Groups implied by the docked object (a mission or task pane). */
  dockGroups?: readonly ToolGroup[];
}): Set<ToolGroup> {
  const groups = new Set<ToolGroup>(CORE_GROUPS);
  for (const g of args.route.area ? [args.route.area] : FALLBACK_GROUPS) groups.add(g);
  for (const g of args.dockGroups ?? []) groups.add(g);
  for (const p of args.continuing?.parts ?? []) {
    if (isToolPart(p)) {
      const g = groupOf(p.type.slice('tool-'.length));
      if (g) groups.add(g);
    }
  }
  if (!args.canAdmin) groups.delete('admin');
  return groups;
}
