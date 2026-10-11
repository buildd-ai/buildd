'use client';

/**
 * The composer: the message, the workspace the turn's tools default to, the
 * tools control (per-group "Ask first" / "Allow") and the tier switch. The
 * switch picks a tier for the conversation, never a model: the tier → model
 * mapping stays the team admin's (knowledge-base: buildd/design/agent-chat.md, "Models: tiers").
 *
 * The box, Enter / Shift+Enter, Send becoming Stop and the toolbar slots are
 * the kit's `ChatComposer` (@builddai/ai-kit/chat/react). buildd fills the
 * slots: `scope` (the workspace switcher or a locked scope), `tools`, `tier`,
 * `edge` (the streaming sweep), `footer` (keyboard hints), `mood` and
 * `compact`; globals.css ("Composer on the kit") draws it as buildd's slab.
 */
import { forwardRef, useImperativeHandle, useRef, type ReactNode } from 'react';
import { ChatComposer as KitComposer, type ChatComposerHandle as KitComposerHandle } from '@builddai/ai-kit/chat/react';
import { CHAT_MAX_MESSAGE_CHARS, type ChatTierName } from '@buildd/shared';
import ToolsMenu from './ToolsMenu';
import TierSwitch from './TierSwitch';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { Kbd, KeyHintsOnly } from '@/components/KeyHints';
import { COMPOSER_INPUT_ID } from './ChatEntry';

export interface ComposerWorkspace { id: string; name: string }

export interface ChatComposerHandle { focus(): void }

interface Props {
  value: string;
  onChange(value: string): void;
  onSend(text: string): void;
  onStop?: () => void;
  /** A turn is streaming: Enter doesn't send, the button stops. */
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  workspaces: readonly ComposerWorkspace[];
  /** The pinned workspace; null = all workspaces (routed per turn). */
  workspaceId: string | null;
  onWorkspaceChange(id: string | null): void;
  /** The workspace the latest turn was routed to, shown while nothing is pinned. */
  routedWorkspace?: ComposerWorkspace | null;
  teamName?: string | null;
  /** The tier the latest turn ran on ("standard"). */
  tier: string | null;
  /**
   * The team the tools and tier controls read and write. Without it (the dev
   * fixtures) the controls are replaced by a static tier label.
   */
  teamId?: string | null;
  conversationId?: string | null;
  /** The conversation's tier pin; null = routed per turn. */
  pinnedTier?: ChatTierName | null;
  onTierChange?(tier: ChatTierName | null): void;
  /** Bump after a turn to refresh the running cost. */
  costRefreshKey?: number;
  /** The narrow docked column, the phone: a shorter box. */
  compact?: boolean;
  /** The canvas mood: `needs` draws the top rule copper (canvas-empty.ts). */
  mood?: 'calm' | 'needs' | null;
  /** Replaces the workspace switcher with a locked scope (the mission sheet). */
  scopeLock?: ReactNode;
}

/** While a turn streams: typing is steering, not a new question. */
export const BUSY_PLACEHOLDER = 'Steer while I think…';

const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer({
  value, onChange, onSend, onStop, busy = false, disabled = false, placeholder = 'Ask about your fleet, or describe the work…',
  workspaces, workspaceId, onWorkspaceChange, routedWorkspace = null, teamName = null, tier, compact = false,
  teamId = null, conversationId = null, pinnedTier = null, onTierChange, costRefreshKey = 0, mood = null, scopeLock,
}, ref) {
  const kit = useRef<KitComposerHandle>(null);
  useImperativeHandle(ref, () => ({ focus: () => kit.current?.focus() }), []);

  const scope = scopeLock ?? (workspaces.length > 0 ? (
    <WorkspaceSwitcher
      variant="chip"
      workspaces={[...workspaces]}
      selectedId={workspaceId}
      onSelect={onWorkspaceChange}
      routed={routedWorkspace}
      teamName={teamName}
    />
  ) : null);
  const tierCell = teamId && onTierChange ? (
    <div className="min-w-[72px] shrink-0 lg:min-w-[88px]">
      <TierSwitch
        teamId={teamId}
        conversationId={conversationId}
        pinned={pinnedTier}
        last={tier}
        onChange={onTierChange}
        refreshKey={costRefreshKey}
      />
    </div>
  ) : tier ? (
    <span data-testid="composer-tier-chip" className="flex w-[72px] shrink-0 items-center justify-center font-mono lg:w-[88px] text-[12px] text-[var(--chat-muted)]">
      {tier}
    </span>
  ) : null;

  return (
    // A full-bleed slab on a phone, a square box on desktop: no radius
    // anywhere in the foreground (knowledge-base: buildd/design/chat-canvas.md). The 2px top
    // rule turns copper while something needs the viewer; while a turn
    // streams a blue segment sweeps along it, the surface's one glow.
    <div data-testid="chat-composer" data-mood={mood ?? undefined}>
      <KitComposer
        ref={kit}
        className="buildd-composer"
        inputId={COMPOSER_INPUT_ID}
        label="Message your agent"
        value={value}
        onChange={onChange}
        onSend={onSend}
        maxLength={CHAT_MAX_MESSAGE_CHARS}
        onStop={onStop}
        busy={busy}
        disabled={disabled}
        placeholder={busy ? BUSY_PLACEHOLDER : placeholder}
        mood={mood}
        compact={compact}
        scope={scope}
        tools={teamId ? <div data-testid="composer-tools-cell" className="w-14 shrink-0 lg:w-16"><ToolsMenu teamId={teamId} /></div> : undefined}
        tier={tierCell}
        edge={busy ? <span data-testid="composer-sweep" data-glow="true" className="composer-sweep" /> : undefined}
        showFormFallback={false}
        footer={(
          // Power users only (Settings -> Profile -> Show keyboard hints).
          <KeyHintsOnly>
            <div data-testid="composer-key-hints" className="hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 font-mono text-[11px] text-text-muted md:flex">
              <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd>send</span>
              <span className="inline-flex items-center gap-1.5"><Kbd>⇧↵</Kbd>new line</span>
              <span className="inline-flex items-center gap-1.5"><Kbd>C</Kbd>chat from any page</span>
            </div>
          </KeyHintsOnly>
        )}
      />
    </div>
  );
});

export default ChatComposer;
