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

export { ChatThread, type ChatThreadProps, type ChatStatus } from './Thread';
export { ChatComposer, DEFAULT_BUSY_PLACEHOLDER, type ChatComposerProps, type ChatComposerHandle } from './Composer';
export {
  ToolsMenu, ToolRows, ScopePicker, TierPicker,
  type ToolsMenuProps, type ScopePickerProps, type ScopeOption, type TierPickerProps, type TierOption,
} from './pickers';
export {
  ThinkingPanel, ApprovalCard, HandoffCard, ChatEmpty, ChatSetupCard,
  type ThinkingPanelProps, type ApprovalCardProps, type HandoffCardProps, type ChatEmptyProps, type ChatEmptyChip, type ChatSetupCardProps,
} from './cards';
export { Menu, MenuOption, KIT_SHEET_QUERY, type MenuProps } from './Menu';
export { useKitChat, type UseKitChatOptions, type KitChat } from './use-kit-chat';
export {
  createComposerStore, useComposerState, applyComposerSeed,
  type ComposerStore, type ComposerPrefsAdapter, type ComposerSeed, type ComposerSnapshot,
} from './composer-store';
export {
  thinkingSteps, isApprovalPart, toolRowState, toolRowLabel, toolSummary, humanizeToolName, tierLabel, greeting,
  type ToolRowState,
} from './model';

export { KIT_CSS_VARS, type KitCssVar } from './vars';
