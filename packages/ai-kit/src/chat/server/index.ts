/**
 * `@builddai/ai-kit/chat/server`: the chat turn runner and tool-permission
 * enforcement (peer `ai@^7`, loaded lazily on the first turn).
 *
 * - `defineToolGroups`, `canSkipCard` / `skipCardVerdict`: the permission
 *   primitive (./permissions).
 * - `createChatTurn`: one streamed turn with server-enforced approval cards,
 *   Allow, hand-offs, thinking steps, Stop and optional mid-turn steering
 *   (./turn).
 * - `modelFromPlan`: the turn's model from a `/models` plan (./model).
 * - `ChatStore` / `memoryChatStore`: the persistence adapter (./store).
 * - `createPermissionsApi`: `GET`/`PATCH` for the per-person preference.
 * - `handoffResult` / `handoffEventMessage`: filing a runner task from chat
 *   and reporting back into the conversation (./handoff).
 * - `SteerQueue` / `memorySteerQueue`: the steering queue adapter.
 * - `classifyTurnError`: a provider failure as a typed, readable `TurnErrorData`
 *   (./errors); the turn writes it as `data-turn-error`.
 * - `titleConversation` / `ruleTitle`: conversation titles, rules before a
 *   model call; `createChatTurn({ title })` runs it, off unless set (./title).
 */

export * from './permissions';
export * from './approvals';
export * from './store';
export * from './steering';
export * from './handoff';
export * from './model';
export * from './permissions-api';
export * from './turn';
export * from './errors';
export * from './title';
