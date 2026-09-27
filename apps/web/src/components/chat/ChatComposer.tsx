'use client';

/**
 * The composer: the message, the workspace the turn's tools default to, the
 * tools control (per-group "Ask first" / "Allow") and the tier switch. The
 * switch picks a tier for the conversation, never a model: the tier → model
 * mapping stays the team admin's (docs/design/agent-chat.md, "Models: tiers").
 */
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';
import type { ChatTierName } from '@buildd/shared';
import ToolsMenu from './ToolsMenu';
import TierSwitch from './TierSwitch';
import { WorkspaceSwitcher } from '@/components/WorkspaceSwitcher';
import { Kbd, KeyHintsOnly } from '@/components/KeyHints';

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
}

const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer({
  value, onChange, onSend, onStop, busy = false, disabled = false, placeholder = 'Ask about your fleet, or describe the work…',
  workspaces, workspaceId, onWorkspaceChange, routedWorkspace = null, teamName = null, tier, compact = false,
  teamId = null, conversationId = null, pinnedTier = null, onTierChange, costRefreshKey = 0,
}, ref) {
  const area = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({
    focus() {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    },
  }), []);

  const send = () => {
    const text = value.trim();
    if (!text || busy || disabled) return;
    onSend(text);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div data-testid="chat-composer">
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className="rounded-[16px] border-[1.5px] border-[var(--convo-line)] bg-surface-2 transition-colors focus-within:border-accent"
      >
        <label htmlFor="chat-composer-input" className="sr-only">Message your agent</label>
        <textarea
          id="chat-composer-input"
          data-bare-input
          ref={area}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`block max-h-48 min-h-12 w-full resize-none ${compact ? '' : 'md:min-h-[76px]'} bg-transparent px-4 py-3 font-convo text-base md:text-[15.5px] text-text-primary placeholder:text-text-muted focus:outline-none focus-visible:outline-none`}
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          {workspaces.length > 0 && (
            <WorkspaceSwitcher
              variant="chip"
              workspaces={[...workspaces]}
              selectedId={workspaceId}
              onSelect={onWorkspaceChange}
              routed={routedWorkspace}
              teamName={teamName}
            />
          )}
          {teamId && <ToolsMenu teamId={teamId} />}
          <span className="flex-1" />
          {teamId && onTierChange ? (
            <TierSwitch
              teamId={teamId}
              conversationId={conversationId}
              pinned={pinnedTier}
              last={tier}
              onChange={onTierChange}
              refreshKey={costRefreshKey}
            />
          ) : tier ? (
            <span data-testid="composer-tier-chip" className="inline-flex min-h-9 items-center rounded-[999px] px-3 font-mono text-[12px] text-text-muted ring-1 ring-inset ring-[var(--convo-line)]">
              {tier}
            </span>
          ) : null}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              data-testid="composer-stop"
              className="grid h-11 w-11 place-items-center rounded-[12px] bg-surface-4 font-mono text-[15px] text-text-primary hover:bg-surface-3"
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              data-testid="composer-send"
              disabled={disabled || !value.trim()}
              className="grid h-11 w-11 place-items-center rounded-[12px] bg-accent font-mono text-[17px] font-bold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-40"
            >
              ↑
            </button>
          )}
        </div>
      </form>
      {/* Power users only (Settings -> Profile -> Show keyboard hints). */}
      <KeyHintsOnly>
        <div data-testid="composer-key-hints" className="mt-2 hidden flex-wrap items-center gap-x-4 gap-y-1 px-1 font-mono text-[11px] text-text-muted md:flex">
          <span className="inline-flex items-center gap-1.5"><Kbd>↵</Kbd>send</span>
          <span className="inline-flex items-center gap-1.5"><Kbd>⇧↵</Kbd>new line</span>
          <span className="inline-flex items-center gap-1.5"><Kbd>C</Kbd>chat from any page</span>
        </div>
      </KeyHintsOnly>
    </div>
  );
});

export default ChatComposer;
