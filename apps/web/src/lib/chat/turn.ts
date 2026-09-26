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
import type { ActionContext, ApiFn } from '@buildd/core/mcp-tools';
import {
  CHAT_EVENT_PART_TYPE,
  type ChatMessagePart,
  type ChatTurnRequest,
  type ChatUnavailableReason,
  type ChatUsage,
} from '@buildd/shared';
import { reconcileApprovals, recordApprovalRequests, dbDecide, storeApprovalResult, isToolPart, type DecideFn } from './approvals';
import { renderChatContextBlock } from './context-block';
import { CHAT_INSTRUCTIONS } from './instructions';
import { routeTurn, FALLBACK_TIER, type TurnRoute } from './routing';
import { resolveChatModel, turnCostUsd, type ChatTier, type ResolvedChatModel } from './models';
import { buildChatTools } from './tools';
import type { LimitVerdict } from './limits';
import type { ApiCall } from './in-process-api';
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
export const TURN_BUDGET_MS = 45_000;
export const MAX_USER_TEXT = 8_000;

export interface TurnUser {
  id: string;
  name: string | null;
  timeZone: string;
  teamRole: 'owner' | 'admin' | 'member';
}

export interface TurnDeps {
  now?: () => Date;
  chatEnabled: (teamId: string) => Promise<boolean>;
  /**
   * Budget and rate limits (limits.checkChatLimits). Required: a turn that
   * passes has been admitted and counted, so there is no unmetered default.
   */
  limits: (args: { teamId: string; userId: string; now: Date }) => Promise<LimitVerdict>;
  route?: (input: Parameters<typeof routeTurn>[0]) => Promise<TurnRoute>;
  resolveModel?: (opts: { tier: ChatTier; teamId: string; workspaceId: string | null; userId: string }) => Promise<ResolvedChatModel>;
  makeApi: (onCall: (c: ApiCall) => void) => ApiFn;
  actionContext: ActionContext;
  decide?: DecideFn;
  /** Link a filed mission to this conversation (missions.conversation_id). */
  linkMission: (missionId: string) => Promise<void>;
  /** Scheduled after the response (Next `after()`); runs inline in tests. */
  later?: (fn: () => Promise<void>) => void;
  autoTitle?: (conversation: ConversationRow, messages: UIMessage[], model: ResolvedChatModel & { ok: true }) => Promise<void>;
  /** Test seam: replace the streamText call. */
  streamTextImpl?: typeof streamText;
}

export function unavailable(reason: ChatUnavailableReason, status: number, extra: Record<string, unknown> = {}): Response {
  const message: Record<ChatUnavailableReason, string> = {
    capability_disabled: 'Chat is not enabled for this team.',
    no_key: 'No provider key is connected for chat. An admin can add a team key, or you can use your own.',
    budget_exhausted: 'Today\'s chat budget is used up. It resets at midnight in the team\'s timezone, and a team owner or admin can raise it. The mission form still works.',
    rate_limited: 'Too many chat turns in the last few minutes. Try again shortly.',
  };
  return Response.json({ error: reason, message: message[reason], ...extra }, { status });
}

/** Stored rows → UI messages for the model. Event rows become short assistant notes. */
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

function userText(message: ChatTurnRequest['message']): string | null {
  const texts = message.parts.filter(p => p.type === 'text').map(p => String((p as { text?: unknown }).text ?? ''));
  const text = texts.join('\n').trim();
  return text && text.length <= MAX_USER_TEXT ? text : null;
}

export async function runChatTurn(args: {
  conversation: ConversationRow;
  workspace: { id: string; name: string } | null;
  user: TurnUser;
  body: ChatTurnRequest;
  deps: TurnDeps;
}): Promise<Response> {
  const { conversation: conv, user, body, deps } = args;
  const now = deps.now?.() ?? new Date();

  // 1. Nothing starts unless the team turned chat on.
  if (!(await deps.chatEnabled(conv.teamId))) return unavailable('capability_disabled', 403);

  const message = body?.message;
  if (!message || (message.role !== 'user' && message.role !== 'assistant') || !Array.isArray(message.parts)) {
    return Response.json({ error: 'message with role and parts is required' }, { status: 400 });
  }

  const text = message.role === 'user' ? userText(message) : null;
  if (message.role === 'user' && !text) {
    return Response.json({ error: `a text message of 1–${MAX_USER_TEXT} characters is required` }, { status: 400 });
  }
  // Limits (budget, then atomic admission) and history load in parallel. Routing
  // waits for the verdict: its decision call is metered spend too, so a refused
  // turn spends nothing.
  const [verdict, stored] = await Promise.all([
    deps.limits({ teamId: conv.teamId, userId: user.id, now }),
    loadMessages(conv.id),
  ]);
  if (!verdict.ok) {
    return unavailable(verdict.reason, 429, {
      message: verdict.message,
      retryAfterSeconds: verdict.retryAfterSeconds,
      ...(verdict.scope ? { scope: verdict.scope } : {}),
    });
  }
  const routePromise = text
    ? (deps.route ?? routeTurn)({ teamId: conv.teamId, workspaceId: conv.workspaceId, userId: user.id, message: text })
    : null;

  const history = toUiHistory(stored);
  const resolveModel = deps.resolveModel ?? resolveChatModel;
  let route: TurnRoute;
  let authorizedToolCallIds = new Set<string>();
  let continuing: MessageRow | null = null;

  if (message.role === 'user') {
    route = await routePromise!;
  } else {
    // An approval answer: it must extend the latest stored assistant message.
    const last = stored.filter(m => m.role === 'assistant').at(-1);
    if (!last || last.id !== message.id) return Response.json({ error: 'approval_not_pending' }, { status: 409 });
    const r = await reconcileApprovals(last.parts, message.parts, deps.decide ?? dbDecide(conv.id, user.id));
    if (r.decided === 0) return Response.json({ error: 'approval_not_pending' }, { status: 409 });
    authorizedToolCallIds = r.authorizedToolCallIds;
    continuing = { ...last, parts: r.parts };
    await updateMessage(last.id, conv.id, { parts: r.parts });
    route = { tier: (last.tier as ChatTier) || FALLBACK_TIER, allowWrites: true, source: 'fallback' };
  }

  // 2. A model for the tier, on the caller's key, else the workspace's, else the team's.
  let model = await resolveModel({ tier: route.tier, teamId: conv.teamId, workspaceId: conv.workspaceId, userId: user.id });
  if (!model.ok && route.tier !== FALLBACK_TIER) {
    model = await resolveModel({ tier: FALLBACK_TIER, teamId: conv.teamId, workspaceId: conv.workspaceId, userId: user.id });
  }
  if (!model.ok) return unavailable('no_key', 409, { provider: model.provider });
  const resolved = model;

  let uiMessages: UIMessage[];
  if (message.role === 'user') {
    const saved = await insertMessage({
      conversationId: conv.id, role: 'user', authorUserId: user.id,
      parts: [{ type: 'text', text: text! }],
      // The routing decision call's spend, so the daily budget counts it.
      usage: route.usage ?? null,
    });
    void pingConversation(conv.id, 'message', saved.id);
    uiMessages = [...history, { id: saved.id, role: 'user', parts: [{ type: 'text', text: text! }] }];
  } else {
    uiMessages = history.map(m => (m.id === continuing!.id ? { ...m, parts: continuing!.parts } as UIMessage : m));
  }

  const tools: ToolSet = buildChatTools({
    ctx: deps.actionContext,
    makeApi: deps.makeApi,
    allowWrites: route.allowWrites,
    authorizedToolCallIds,
    onMissionFiled: async ({ missionId, toolCallId, result }) => {
      await deps.linkMission(missionId);
      await storeApprovalResult(toolCallId, conv.id, result).catch(() => {});
    },
  });

  let approvalsThisTurn = 0;
  const instructions = `${CHAT_INSTRUCTIONS}\n\n${renderChatContextBlock({
    now,
    timeZone: user.timeZone,
    conversationId: conv.id,
    workspace: args.workspace,
    user: { name: user.name, teamRole: user.teamRole, isOperator: user.teamRole !== 'member' },
    tier: resolved.tier,
    budgetWarning: verdict.budgetWarning,
  })}`;

  const result = (deps.streamTextImpl ?? streamText)({
    model: resolved.model as LanguageModel,
    instructions,
    messages: await convertToModelMessages(uiMessages, { tools, ignoreIncompleteToolCalls: true }),
    tools,
    stopWhen: isStepCount(MAX_STEPS),
    abortSignal: AbortSignal.timeout(TURN_BUDGET_MS),
    toolApproval: {
      manage_missions: (input: { action?: string }) => {
        if (input?.action !== 'create') return 'not-applicable';
        // At most one approval card per turn; a second write waits.
        approvalsThisTurn += 1;
        return approvalsThisTurn === 1
          ? 'user-approval'
          : { type: 'denied', reason: 'Only one approval card per turn. Ask the user after this one is answered.' };
      },
    },
  });

  const stream = toUIMessageStream({
    stream: result.stream,
    tools,
    originalMessages: uiMessages,
    generateMessageId: () => randomUUID(),
    onEnd: async ({ responseMessage, isContinuation, isAborted }) => {
      try {
        const parts = [...(responseMessage.parts as ChatMessagePart[])];
        if (isAborted) parts.push({ type: 'text', text: '_Stopped: this turn hit its time limit._' });
        let usage: ChatUsage | null = null;
        try {
          const u = await result.usage;
          const meta = (await result.providerMetadata) as Record<string, unknown> | undefined;
          usage = {
            inputTokens: u?.inputTokens ?? 0,
            outputTokens: u?.outputTokens ?? 0,
            costUsd: turnCostUsd(resolved.modelId, u, meta),
          };
        } catch { /* aborted streams may have no usage */ }

        const messageId = isContinuation && continuing ? continuing.id : responseMessage.id;
        if (isContinuation && continuing) {
          const prior = continuing.usage;
          await updateMessage(messageId, conv.id, {
            parts,
            usage: usage && prior ? {
              inputTokens: prior.inputTokens + usage.inputTokens,
              outputTokens: prior.outputTokens + usage.outputTokens,
              costUsd: (prior.costUsd ?? 0) + (usage.costUsd ?? 0),
            } : usage ?? prior ?? null,
            model: resolved.modelId,
          });
        } else {
          await insertMessage({
            id: messageId, conversationId: conv.id, role: 'assistant', parts,
            tier: resolved.tier, model: resolved.modelId, usage,
          });
        }
        await recordApprovalRequests({ conversationId: conv.id, messageId, userId: user.id, parts });
        await pingConversation(conv.id, 'message', messageId);

        if (!conv.title && message.role === 'user' && deps.autoTitle) {
          const done = [...uiMessages, { ...responseMessage, parts } as UIMessage];
          (deps.later ?? (fn => void fn()))(() => deps.autoTitle!(conv, done, resolved));
        }
      } catch (e) {
        console.error(`[chat] failed to persist turn for conversation ${conv.id}:`, e);
      }
    },
  });

  return createUIMessageStreamResponse({
    stream,
    // Keep consuming if the client disconnects, so onEnd still saves the turn.
    consumeSseStream: ({ stream: s }) => consumeStream({ stream: s }),
    headers: { 'x-buildd-chat-tier': resolved.tier },
  });
}
