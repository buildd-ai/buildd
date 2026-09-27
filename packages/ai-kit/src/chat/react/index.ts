/**
 * `@builddai/ai-kit/chat/react`: UI components over `/chat/contract`
 * (peers `react@^19`, `@ai-sdk/react@^4`).
 *
 * P0 SKELETON: prop types only. The components (`ChatThread`, `ChatComposer`,
 * `ToolsMenu`, `TierPicker`, `ThinkingPanel`, `ApprovalCard`, `ChatEmpty`,
 * `ChatSetupCard`, …) ship with P3. They style themselves only through the
 * `--kit-*` custom properties in `@builddai/ai-kit/chat/theme.css`, plus
 * `className` and `data-*` hooks. No Tailwind.
 */

import type { ToolPermissionRow } from '@builddai/ai-kit/chat/contract';

/** A one-tap chip on the empty state. `send: false` prefills the composer instead of sending. */
export interface ChatEmptyChip {
  label: string;
  text: string;
  send: boolean;
}

export interface ChatEmptyProps {
  name?: string;
  chips: readonly ChatEmptyChip[];
  onChip(chip: ChatEmptyChip): void;
}

export interface ToolsMenuProps {
  rows: readonly ToolPermissionRow[];
  onChange(key: string, mode: 'ask' | 'allow'): void;
  className?: string;
}

export interface ChatComposerProps {
  onSend(text: string): void;
  onStop?(): void;
  busy: boolean;
  /** Shows "Fill in a form instead" until the first message. */
  formFallbackHref?: string;
  className?: string;
}

/** The CSS custom properties the kit's components read. Map them once from the app's tokens. */
export const KIT_CSS_VARS = [
  '--kit-bg',
  '--kit-surface',
  '--kit-ink',
  '--kit-muted',
  '--kit-accent',
  '--kit-accent-ink',
  '--kit-radius-soft',
  '--kit-radius-hard',
  '--kit-font-body',
  '--kit-font-mono',
] as const;
export type KitCssVar = (typeof KIT_CSS_VARS)[number];
