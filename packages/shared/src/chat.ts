/**
 * Agent chat — the wire contract shared by the chat API, the chat UI and the
 * settings UI. See `docs/design/agent-chat.md`.
 *
 * Nothing here imports the AI SDK: message `parts` are AI SDK v7 `UIMessage`
 * parts on the wire, but this package stays dependency-free so the runner and
 * core can read the types too. The UI narrows `ChatMessagePart` with the SDK's
 * own guards (`isToolUIPart`, `isDataUIPart`, …).
 */

// ── Providers and keys ────────────────────────────────────────────────────────

/**
 * Model API providers a chat turn (and an inference/decision call) can be
 * billed to. Chat never runs on a subscription seat, so `openai-codex` is not
 * here — it's a runner-only backend.
 */
export const CHAT_PROVIDERS = ['anthropic', 'openai', 'openrouter'] as const;
export type ChatProvider = (typeof CHAT_PROVIDERS)[number];

export function isChatProvider(value: unknown): value is ChatProvider {
  return typeof value === 'string' && (CHAT_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Who a provider key belongs to. Resolution is most specific first:
 * user → workspace → team (then an env var, outside production only).
 */
export type ProviderKeyScope = 'user' | 'workspace' | 'team';

export type ProviderKeyHealth = 'healthy' | 'degraded' | 'revoked' | 'unknown';

/**
 * A stored provider key as the settings UI sees it. The plaintext never leaves
 * the server; `last4` is the only part of the value that does.
 */
export interface MaskedProviderKey {
  id: string;
  provider: ChatProvider;
  scope: ProviderKeyScope;
  /** Last four characters of the key, e.g. `"a1b2"`. Render as `…a1b2`. */
  last4: string;
  health: ProviderKeyHealth;
  /** When the key was last checked against the provider (ISO 8601), if ever. */
  lastVerifiedAt: string | null;
  /** Provider error from the last failed check, if the last check failed. */
  lastVerificationError: string | null;
  updatedAt: string;
  /**
   * The stored purpose. `inference_key` is the one this API sets and deletes.
   * A team card can also show a key that already serves chat from elsewhere —
   * the runner's `anthropic_api_key`, or a legacy OpenRouter `decision_key` —
   * which is managed where it was set (Agent backends), so the UI shouldn't
   * offer Delete for it here.
   */
  source: 'inference_key' | 'anthropic_api_key' | 'decision_key';
}

/** One card per provider on the Provider keys screen. */
export interface ProviderKeySummary {
  provider: ChatProvider;
  /** The team-wide key, or null. */
  team: MaskedProviderKey | null;
  /** The caller's own key, or null. */
  mine: MaskedProviderKey | null;
  /**
   * How many team members have their own key for this provider. Admins only;
   * null for members (they don't get to see other people's settings).
   */
  membersWithOwnKey: number | null;
}

/** `GET /api/inference-keys?teamId=` */
export interface ListProviderKeysResponse {
  teamId: string;
  /** Whether the caller can set/delete team-scope keys (team owner/admin). */
  canManageTeamKeys: boolean;
  providers: ProviderKeySummary[];
}

/** `PUT /api/inference-keys` */
export interface SetProviderKeyRequest {
  teamId: string;
  provider: ChatProvider;
  /** `team` needs owner/admin. `workspace` scope is not settable in P1. */
  scope: 'user' | 'team';
  value: string;
}

/** `PUT /api/inference-keys` → the stored key, checked against the provider. */
export interface SetProviderKeyResponse {
  key: MaskedProviderKey;
}

/** `DELETE /api/inference-keys?teamId=&provider=&scope=` → `{ deleted: boolean }` */
export interface DeleteProviderKeyResponse {
  deleted: boolean;
}

/** `POST /api/inference-keys/verify` body. Re-checks a stored key. */
export interface VerifyProviderKeyRequest {
  teamId: string;
  provider: ChatProvider;
  scope: 'user' | 'team';
}

// ── Objects in the feed ───────────────────────────────────────────────────────

/**
 * What a chat answer can point at. `directive` renderers land in P2 alongside
 * memory tiers; a P1 client should render its `fallbackText`.
 */
export const BUILDD_OBJECT_KINDS = [
  'mission', 'task', 'pr', 'question', 'schedule', 'artifact', 'directive',
] as const;
export type BuilddObjectKind = (typeof BUILDD_OBJECT_KINDS)[number];

interface BuilddObjectRefBase {
  kind: BuilddObjectKind;
  /** Primary key of the object (see each kind for what it means). */
  id: string;
  workspaceId: string | null;
  /**
   * Plain text for surfaces that can't render the live object (Slack, email,
   * a deleted object, an unknown kind). Always present, always human-readable.
   */
  fallbackText: string;
  /**
   * Display hint captured when the ref was made. The renderer fetches live
   * state through the authenticated GET route and prefers that — a ref is a
   * pointer, never a snapshot.
   */
  title?: string;
}

/** `id` = `missions.id`. Live: `GET /api/missions/[id]`, channel `mission-{id}`. */
export interface MissionObjectRef extends BuilddObjectRefBase { kind: 'mission' }

/** `id` = `tasks.id`. Live: `GET /api/tasks/[id]`, channel `task-{id}`. */
export interface TaskObjectRef extends BuilddObjectRefBase { kind: 'task' }

/** `id` = `"{owner}/{repo}#{number}"`. */
export interface PrObjectRef extends BuilddObjectRefBase {
  kind: 'pr';
  repo: string;
  prNumber: number;
  url: string;
  /** The task whose worker opened the PR, when known. */
  taskId?: string;
}

/**
 * A waiting-input question. `id` = the waiting `workers.id`, which is what
 * `POST /api/workers/[id]/respond` takes. Tapping an option is the approval.
 */
export interface QuestionObjectRef extends BuilddObjectRefBase {
  kind: 'question';
  taskId: string;
  missionId?: string | null;
}

/** `id` = `taskSchedules.id`. */
export interface ScheduleObjectRef extends BuilddObjectRefBase { kind: 'schedule' }

/** `id` = `artifacts.id`. */
export interface ArtifactObjectRef extends BuilddObjectRefBase { kind: 'artifact' }

/** `id` = `memories.id` (tier `directive`). P2. */
export interface DirectiveObjectRef extends BuilddObjectRefBase { kind: 'directive' }

export type BuilddObjectRef =
  | MissionObjectRef
  | TaskObjectRef
  | PrObjectRef
  | QuestionObjectRef
  | ScheduleObjectRef
  | ArtifactObjectRef
  | DirectiveObjectRef;

export function isBuilddObjectRef(value: unknown): value is BuilddObjectRef {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.kind === 'string'
    && (BUILDD_OBJECT_KINDS as readonly string[]).includes(v.kind)
    && typeof v.id === 'string'
    && typeof v.fallbackText === 'string';
}

/**
 * Every buildd tool the chat can call returns this as its tool `output`.
 * `data` is what the model reads; `objects` is what the client renders.
 */
export interface ChatToolResult<T = unknown> {
  data: T;
  objects: BuilddObjectRef[];
  /**
   * One-line result for the collapsed tool row
   * (`"3 open, none touch currency"`). Optional; the UI falls back to the
   * object count.
   */
  summary?: string;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

/**
 * Tool naming convention: a chat tool is named after the MCP action it wraps
 * (`packages/core/mcp-tools.ts`), so the UI part type is `tool-{action}` —
 * `tool-list_tasks`, `tool-manage_missions`. Actions with sub-operations carry
 * them in `input.action` (`manage_missions` + `{ action: 'create' }`), and the
 * approval card header renders `manage_missions · create`.
 */
export const CHAT_READ_TOOLS = [
  'list_tasks',
  'get_task',
  'manage_missions', // list | get | get_criteria_state run straight away
  'list_schedules',
  'trace_schedule',
  'list_artifacts',
  // Not yet: get_artifact, get_pr, get_pr_review, query_events,
  // get_budget_forecast and explain sit on routes that don't accept a
  // dashboard session yet (chat tools run as the signed-in user); recall
  // arrives with memory tiers (P2). check_path_claim needs a worker context.
] as const;
export type ChatReadTool = (typeof CHAT_READ_TOOLS)[number];

/**
 * (tool, sub-action) pairs that render as an approval card instead of running.
 * P1 ships exactly one: filing a mission.
 */
export const CHAT_APPROVAL_TOOLS: Readonly<Record<string, readonly string[]>> = {
  manage_missions: ['create'],
};

/** Does this tool call need an approval card before it runs? */
export function chatToolNeedsApproval(tool: string, input: unknown): boolean {
  const subs = CHAT_APPROVAL_TOOLS[tool];
  if (!subs) return false;
  const action = input && typeof input === 'object' ? (input as { action?: unknown }).action : undefined;
  return typeof action === 'string' && subs.includes(action);
}

/**
 * Tool part states, as AI SDK v7 names them. A tool that needs approval moves
 * `input-available → approval-requested → approval-responded →
 * output-available | output-denied`; a read tool goes
 * `input-streaming → input-available → output-available | output-error`.
 */
export type ChatToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'approval-requested'
  | 'approval-responded'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

// ── Conversations and messages ────────────────────────────────────────────────

export type ConversationTitleSource = 'auto' | 'user';

export interface ConversationDTO {
  id: string;
  teamId: string;
  /** Default scope for tool calls; null = the user's whole team. */
  workspaceId: string | null;
  createdByUserId: string;
  /** Display title — never null; an untitled conversation reads "New conversation". */
  title: string;
  titleSource: ConversationTitleSource;
  agentRoleSlug: string;
  lastMessageAt: string;
  archivedAt: string | null;
  createdAt: string;
}

export type ConversationMessageRole = 'user' | 'assistant' | 'event';
export type ConversationSurface = 'web' | 'slack' | 'discord' | 'teams';

/**
 * A `UIMessage` part. Known shapes: `{ type: 'text', text }`,
 * `{ type: 'step-start' }`, `{ type: 'reasoning', text }`,
 * `{ type: 'tool-{name}', toolCallId, state, input, output?, approval? }` where
 * `output` is a `ChatToolResult`, and `{ type: 'data-buildd-event', data }`
 * (see `ChatEventData`).
 */
export type ChatMessagePart = { type: string; [key: string]: unknown };

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /** Null when the provider didn't report a cost and no price is known. */
  costUsd: number | null;
}

export interface ConversationMessageDTO {
  id: string;
  conversationId: string;
  role: ConversationMessageRole;
  parts: ChatMessagePart[];
  authorUserId: string | null;
  surface: ConversationSurface;
  /** Tier the turn ran on (`budget | standard | premium`), assistant only. */
  tier: string | null;
  /** Resolved model id, assistant only — shown read-only, never picked. */
  model: string | null;
  usage: ChatUsage | null;
  createdAt: string;
}

/**
 * Planning-mode updates posted back into the conversation a mission was filed
 * from: `role: 'event'`, one part `{ type: 'data-buildd-event', data }`.
 */
export type ChatEventKind =
  | 'plan_ready'       // the Organizer produced a plan for a mission filed here
  | 'question'         // a worker on that mission is waiting on input
  | 'mission_completed'
  | 'mission_failed';

export interface ChatEventData {
  event: ChatEventKind;
  objects: BuilddObjectRef[];
  /** One line of plain text, e.g. "Plan ready: 12 tasks". */
  text: string;
}

export const CHAT_EVENT_PART_TYPE = 'data-buildd-event' as const;

export type ConversationApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ConversationApprovalDTO {
  /** The AI SDK approval id (`part.approval.id`) the client echoes back. */
  id: string;
  messageId: string;
  toolName: string;
  status: ConversationApprovalStatus;
  decidedAt: string | null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** `POST /api/chat` */
export interface CreateConversationRequest {
  teamId?: string;
  workspaceId?: string | null;
}
export interface CreateConversationResponse {
  conversation: ConversationDTO;
}

/** `GET /api/chat?cursor=&limit=` — the caller's conversations, newest first. */
export interface ListConversationsResponse {
  conversations: ConversationDTO[];
  nextCursor: string | null;
}

/** `GET /api/chat/[id]` */
export interface GetConversationResponse {
  conversation: ConversationDTO;
  messages: ConversationMessageDTO[];
  approvals: ConversationApprovalDTO[];
}

/** `PATCH /api/chat/[id]` — rename (sets `titleSource: 'user'`) or archive. */
export interface UpdateConversationRequest {
  title?: string;
  archived?: boolean;
}

/**
 * `POST /api/chat/[id]` — stream one turn (UI message stream over SSE).
 *
 * The server's stored history is the source of truth. Send only the newest
 * message: the new user message, or the assistant message whose tool parts now
 * carry `approval-responded` (configure `DefaultChatTransport` with
 * `prepareSendMessagesRequest: ({ messages }) => ({ body: { message: messages.at(-1) } })`).
 * Approvals are checked server-side against `conversation_approvals` (id, input
 * hash, approving user), so a replayed or edited approval executes nothing.
 */
export interface ChatTurnRequest {
  message: { id: string; role: 'user' | 'assistant'; parts: ChatMessagePart[] };
}

/**
 * Why a turn was refused before any model call. Returned as JSON with a 4xx
 * status instead of a stream. `no_key` / `capability_disabled` ⇒ show the
 * setup card and the mission form, keeping the draft text.
 */
export type ChatUnavailableReason =
  | 'capability_disabled'
  | 'no_key'
  | 'budget_exhausted'
  | 'rate_limited';

export interface ChatUnavailableResponse {
  error: ChatUnavailableReason;
  message: string;
  /** Whether the caller can fix it themselves (admin: add a team key). */
  canManageTeamKeys?: boolean;
  retryAfterSeconds?: number;
}

/** `GET /api/chat/availability?teamId=` — should the UI show a Chat entry point? */
export interface ChatAvailabilityResponse {
  available: boolean;
  reason: ChatUnavailableReason | null;
  canManageTeamKeys: boolean;
}

// ── Realtime ──────────────────────────────────────────────────────────────────

/**
 * Pusher carries pings, not content: channels are public-named, so message text
 * never goes over Pusher. After a message is saved the server sends
 * `conversation:updated` on `conversation-{id}` and other devices refetch
 * through `GET /api/chat/[id]`. Live objects use their existing channels.
 *
 * Channel names here are unprefixed; add `PUSHER_CHANNEL_PREFIX` as the other
 * channels do (`CHANNEL_PREFIX` from `@/lib/pusher-client`).
 */
export const CHAT_PUSHER_EVENTS = {
  CONVERSATION_UPDATED: 'conversation:updated',
} as const;

export function conversationChannelName(conversationId: string): string {
  return `conversation-${conversationId}`;
}

export type ConversationUpdatedReason = 'message' | 'title' | 'approval' | 'event' | 'archived';

export interface ConversationUpdatedPayload {
  conversationId: string;
  /** The saved message, when the update is a message. */
  messageId?: string;
  reason: ConversationUpdatedReason;
}
