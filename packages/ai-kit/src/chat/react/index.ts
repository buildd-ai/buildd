'use client';

/**
 * `@builddai/ai-kit/chat/react`: chat UI over `/chat/contract`
 * (peers `react@^19`, `react-dom@^19`, `@ai-sdk/react@^4`, `ai@^7`).
 *
 * Components style themselves only through the `--kit-*` custom properties
 * (`@builddai/ai-kit/chat/theme.css`) and the `kit-*` classes in
 * `@builddai/ai-kit/chat/styles.css`, plus `className` and `data-*` hooks.
 * No Tailwind. Import both stylesheets once:
 *
 * ```ts
 * import '@builddai/ai-kit/chat/theme.css';
 * import '@builddai/ai-kit/chat/styles.css';
 * ```
 */

export { ChatThread, type ChatThreadProps, type ChatStatus, type ThreadMessageContext, type TurnFold } from './Thread';
export { ChatComposer, DEFAULT_BUSY_PLACEHOLDER, type ChatComposerProps, type ChatComposerHandle } from './Composer';
export {
  ToolsMenu, ToolRows, ScopePicker, TierPicker,
  type ToolsMenuProps, type ScopePickerProps, type ScopeOption, type TierPickerProps, type TierOption,
} from './pickers';
export {
  ThinkingPanel, ApprovalCard, HandoffCard, ChatEmpty, ChatSetupCard,
  type ThinkingPanelProps, type ApprovalCardProps, type HandoffCardProps, type ChatEmptyProps, type ChatEmptyChip, type ChatSetupCardProps,
} from './cards';
export { Menu, MenuOption, KIT_SHEET_QUERY, MENU_EDGE, fitMenuPanel, menuDropSide, menuShift, type MenuProps } from './Menu';
export { useKitChat, type UseKitChatOptions, type KitChat } from './use-kit-chat';
export {
  createComposerStore, useComposerState, applyComposerSeed, tierPrefs,
  type ComposerStore, type ComposerStoreOptions, type ComposerPrefsAdapter, type TierPrefsAdapter, type ComposerSeed, type ComposerSnapshot,
} from './composer-store';
export {
  thinkingSteps, isApprovalPart, toolRowState, toolRowLabel, toolSummary, humanizeToolName, tierLabel, greeting,
  formatCost, formatPer1k,
  type ToolRowState,
} from './model';

// 0.5.0: lifted from buildd's chat.
export {
  TurnFeedback, TurnFeedbackProvider, useTurnFeedback, DEFAULT_FEEDBACK_REASONS,
  type TurnFeedbackProviderProps, type TurnFeedbackEvent, type FeedbackReason,
} from './TurnFeedback';
export {
  SteerComposer, steerStatusLabel, steerTitle, canSteer,
  type SteerComposerProps, type SteerMessage, type SteerDelivery, type SteerPresenceItem,
} from './SteerComposer';
export {
  createObjectStore, createTrailingThrottle, idleEntry, realClock, OBJECT_REFRESH_WINDOW_MS,
  type ObjectStore, type ObjectSource, type ObjectEntry, type ObjectStoreOptions, type ObjectEventEffect, type KitClock,
} from './object-store';
export {
  paneReducer, parsePaneSide, dockChoice, INITIAL_PANE, PANE_SIDE_KEY,
  type PaneState, type PaneAction, type PaneSide, type DockMode, type DockChoice,
} from './object-dock';
export {
  ObjectStoreProvider, useObjectStore, useObjectEntry, ObjectCard, ObjectPane, ObjectPlaceholder, PinnedObject, pinnedObjectTitle,
  type ObjectStoreProviderProps, type ObjectRenderer, type ObjectRenderers, type ObjectVariant, type PinnedObjectProps,
} from './objects';
export { createPendingMessages, DEFAULT_PENDING_PREFIX, type PendingMessages, type PendingStorage } from './pending-message';
export {
  approvalDraft, approvalLabel, firstParagraph, toolAction, toolInput,
  type ApprovalDraft, type PreviewDraft, type GenericDraft,
} from './approval-draft';

// 0.6.0: per-app tier policy (also in /chat/contract, for the server).
export { defineTierPolicy, type TierPolicy, type TierPolicyOptions, type ChatTier } from '@builddai/ai-kit/chat/contract';

// 0.11.0: rich tool rows (lifted from buildd's chat).
export {
  ToolCallRow, ToolCallGroup,
  type ToolCallRowProps, type ToolCallGroupProps,
} from './ToolCalls';
export {
  toolCallView, toolCallState, toolCallResult, keyArgs, toolGroupSummary, DEFAULT_KEY_ARG_SKIP,
  type ToolCallView, type ToolCallState, type ToolCallOptions, type KeyArgsOptions, type ToolGroupSummary,
} from './tool-calls';

export { KIT_CSS_VARS, KIT_MENU_FIT_VARS, type KitCssVar } from './vars';
