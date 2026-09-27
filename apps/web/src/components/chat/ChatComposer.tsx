'use client';

/**
 * The composer: the message, the workspace the turn's tools default to, the
 * tools control (per-group "Ask first" / "Allow") and the tier switch. The
 * switch picks a tier for the conversation, never a model: the tier → model
 * mapping stays the team admin's (docs/design/agent-chat.md, "Models: tiers").
 */
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent, type ReactNode } from 'react';
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
  /** The canvas mood: `needs` draws the top rule copper (canvas-empty.ts). */
  mood?: 'calm' | 'needs' | null;
  /** Replaces the workspace switcher with a locked scope (the mission sheet). */
  scopeLock?: ReactNode;
}

const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer({
  value, onChange, onSend, onStop, busy = false, disabled = false, placeholder = 'Ask about your fleet, or describe the work…',
  workspaces, workspaceId, onWorkspaceChange, routedWorkspace = null, teamName = null, tier, compact = false,
  teamId = null, conversationId = null, pinnedTier = null, onTierChange, costRefreshKey = 0, mood = null, scopeLock,
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

  const needs = mood === 'needs';
  return (
    <div data-testid="chat-composer" data-mood={mood ?? undefined}>
      {/* A full-bleed slab on a phone, a square box on desktop: no radius
          anywhere in the foreground (docs/design/chat-canvas.md). The 2px top
          rule turns copper while something needs the viewer. */}
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className={`border-t-2 bg-[var(--chat-surface)] transition-colors md:border-x md:border-b md:border-x-[var(--chat-rule)] md:border-b-[var(--chat-rule)] ${needs ? 'border-t-[var(--mood-needs)]' : 'border-t-[var(--chat-rule-strong)] focus-within:border-t-[var(--chat-text)]'}`}
      >
        <label htmlFor="chat-composer-input" className="sr-only">Message your agent</label>
        {/* At least 64px and two rows, and sized to its content where the
            browser can, so a long placeholder wraps instead of clipping. */}
        <textarea
          id="chat-composer-input"
          data-bare-input
          data-composer-input
          ref={area}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`block max-h-48 min-h-16 w-full resize-none [field-sizing:content] ${compact ? '' : 'md:min-h-[76px]'} bg-transparent px-4 py-3 font-voice text-[17px] leading-[1.35] text-[var(--chat-text)] placeholder:text-[var(--chat-muted)] focus:outline-none focus-visible:outline-none md:text-[16px]`}
        />
        <div data-testid="composer-toolbar" className="flex h-12 items-stretch divide-x divide-[var(--chat-rule)] border-t border-[var(--chat-rule)]">
          <div className="min-w-0 flex-1">
            {scopeLock ?? (workspaces.length > 0 && (
              <WorkspaceSwitcher
                variant="chip"
                workspaces={[...workspaces]}
                selectedId={workspaceId}
                onSelect={onWorkspaceChange}
                routed={routedWorkspace}
                teamName={teamName}
              />
            ))}
          </div>
          {teamId && <div className="w-14 shrink-0"><ToolsMenu teamId={teamId} /></div>}
          {teamId && onTierChange ? (
            <div className="min-w-[72px] shrink-0">
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
            <span data-testid="composer-tier-chip" className="flex w-[72px] shrink-0 items-center justify-center font-mono text-[12px] text-[var(--chat-muted)]">
              {tier}
            </span>
          ) : null}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              data-testid="composer-stop"
              className="grid w-[60px] shrink-0 place-items-center bg-[var(--chat-text)] hover:opacity-90"
            >
              <span aria-hidden="true" className="h-3 w-3 bg-[var(--chat-ground)]" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              data-testid="composer-send"
              disabled={disabled || !value.trim()}
              className="grid w-[60px] shrink-0 place-items-center bg-[var(--mood-needs-fill)] font-mono text-[20px] font-bold text-[var(--on-mood-needs)] hover:brightness-110 disabled:opacity-60"
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
