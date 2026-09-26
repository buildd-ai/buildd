'use client';

/**
 * The composer: the message, the workspace the turn's tools default to, and a
 * read-only chip naming the tier the team's admin mapped chat to. There is no
 * model picker, by design (docs/design/agent-chat.md, "Models: tiers, not a
 * model picker").
 */
import { forwardRef, useImperativeHandle, useRef, type KeyboardEvent } from 'react';

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
  workspaceId: string | null;
  onWorkspaceChange(id: string): void;
  /** "standard" — shown, never chosen here. */
  tier: string | null;
  /** Hide the keyboard hints (the narrow docked column, the phone). */
  compact?: boolean;
}

const ChatComposer = forwardRef<ChatComposerHandle, Props>(function ChatComposer({
  value, onChange, onSend, onStop, busy = false, disabled = false, placeholder = 'Ask about your fleet, or describe the work…',
  workspaces, workspaceId, onWorkspaceChange, tier, compact = false,
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
  const ws = workspaces.find(w => w.id === workspaceId) ?? null;

  return (
    <div data-testid="chat-composer">
      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        className="border-2 border-border-strong bg-surface-2 shadow-[var(--card-shadow)] focus-within:border-accent"
      >
        <label htmlFor="chat-composer-input" className="sr-only">Message your agent</label>
        <textarea
          id="chat-composer-input"
          ref={area}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          className={`block max-h-48 min-h-12 w-full resize-none ${compact ? '' : 'md:min-h-[76px]'} bg-transparent px-4 py-3 font-[family-name:var(--font-outfit)] text-base md:text-[15.5px] text-text-primary placeholder:text-text-muted focus:outline-none`}
        />
        <div className="flex items-center gap-2 border-t border-border-default px-3 py-2">
          {workspaces.length > 0 && (
            <label data-testid="composer-scope-chip" className="relative inline-flex min-h-9 items-center border-[1.5px] border-border-strong px-2.5 font-mono text-[12.5px] font-medium text-text-primary hover:bg-surface-3">
              <span aria-hidden="true" className="mr-1.5 text-text-muted">@</span>
              <span className="max-w-[16ch] truncate">{ws?.name ?? 'workspace'}</span>
              <span className="sr-only">Workspace for this conversation</span>
              <select
                value={workspaceId ?? ''}
                onChange={(e) => onWorkspaceChange(e.target.value)}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="Workspace for this conversation"
              >
                {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
              </select>
            </label>
          )}
          <span className="flex-1" />
          {tier && (
            <span
              data-testid="composer-tier-chip"
              title="Your team admin maps chat to a tier in Settings. It isn't chosen per message."
              className="hidden min-h-9 items-center border-[1.5px] border-dashed border-border-strong px-2.5 font-mono text-[12px] text-text-muted sm:inline-flex"
            >
              running on&nbsp;<b className="font-semibold text-text-primary">{tier}</b>
            </span>
          )}
          {busy && onStop ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              data-testid="composer-stop"
              className="grid h-11 w-11 place-items-center border-2 border-border-strong bg-surface-3 font-mono text-[15px] text-text-primary hover:bg-surface-4"
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              data-testid="composer-send"
              disabled={disabled || !value.trim()}
              className="grid h-11 w-11 place-items-center border-2 border-[var(--on-accent)] bg-accent font-mono text-[17px] font-bold text-[var(--on-accent)] hover:bg-primary-hover disabled:opacity-50"
            >
              ↑
            </button>
          )}
        </div>
      </form>
      {!compact && (
        <div className="mt-2 hidden justify-between gap-4 font-mono text-[11.5px] text-text-muted md:flex">
          <span>Enter to send · Shift+Enter for a new line</span>
          <span>Reads run on their own. Filing asks you first.</span>
        </div>
      )}
    </div>
  );
});

export default ChatComposer;
