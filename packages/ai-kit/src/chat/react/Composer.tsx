'use client';

/**
 * The composer: the message box, the toolbar slots (scope, tools, tier) and
 * Send, which becomes Stop while a turn streams. With `onSteer`, typing while
 * busy steers the running turn ("applies at the next step") instead of being
 * held; without it, Enter does nothing until the turn ends.
 *
 * Controlled (`value` + `onChange`) or uncontrolled. Enter sends, Shift+Enter
 * is a new line, and an IME composition never sends.
 */
import { forwardRef, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

export interface ChatComposerHandle {
  focus(): void;
  /** Replace the draft (e.g. a chip that prefills) and focus the end. */
  prefill(text: string): void;
}

export interface ChatComposerProps {
  onSend(text: string): void;
  /** Stop the running turn. Without it, the Stop button is disabled. */
  onStop?(): void;
  /** A turn is streaming. */
  busy?: boolean;
  disabled?: boolean;
  value?: string;
  defaultValue?: string;
  onChange?(value: string): void;
  placeholder?: string;
  /** Steer the running turn. When set, the busy placeholder invites it. */
  onSteer?(text: string): void;
  busyPlaceholder?: string;
  /** Toolbar slots: e.g. `<ScopePicker>`, `<ToolsMenu>`, `<TierPicker>`. */
  scope?: ReactNode;
  tools?: ReactNode;
  tier?: ReactNode;
  /** "Fill in a form instead": a link (`formFallbackHref`) or any node (`formFallback`). */
  formFallbackHref?: string;
  formFallback?: ReactNode;
  formFallbackLabel?: string;
  /** Show the form fallback. Pass `messages.length === 0`: it shows until the first message. */
  showFormFallback?: boolean;
  /** Accessible name of the message box. */
  label?: string;
  autoFocus?: boolean;
  className?: string;
  /**
   * A row inside the box, above the message: e.g. a chip for the object the
   * message is about, or a locked scope. Nothing renders without it.
   */
  leading?: ReactNode;
  /** Extra toolbar controls, after `tier` and before Send (e.g. attach, a voice button). */
  actions?: ReactNode;
  /** Decoration drawn inside the box, over its top edge (e.g. a streaming sweep). Hidden from assistive tech. */
  edge?: ReactNode;
  /** Under the box, after the form fallback (e.g. keyboard hints). */
  footer?: ReactNode;
  /** An app-defined mood on the box as `data-mood` (e.g. `needs` to tint its rule). */
  mood?: string | null;
  /** A shorter box, for a narrow docked column (`data-compact`). */
  compact?: boolean;
}

export const DEFAULT_BUSY_PLACEHOLDER = 'Steer while I think…';

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  onSend, onStop, busy = false, disabled = false, value, defaultValue = '', onChange,
  placeholder = 'Ask anything…', onSteer, busyPlaceholder = DEFAULT_BUSY_PLACEHOLDER,
  scope, tools, tier, formFallbackHref, formFallback, formFallbackLabel = 'Fill in a form instead',
  showFormFallback = true, label = 'Message', autoFocus, className,
  leading, actions, edge, footer, mood = null, compact = false,
}, ref) {
  const [inner, setInner] = useState(defaultValue);
  const [steerSent, setSteerSent] = useState(false);
  const controlled = value !== undefined;
  const text = controlled ? value : inner;
  const area = useRef<HTMLTextAreaElement>(null);
  const inputId = useId();
  const hintId = useId();

  const set = (v: string) => {
    if (!controlled) setInner(v);
    onChange?.(v);
  };
  const focusEnd = () => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  useImperativeHandle(ref, () => ({
    focus: focusEnd,
    prefill(t: string) {
      set(t);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusEnd); else focusEnd();
    },
  }));

  const submit = () => {
    const t = text.trim();
    if (!t || disabled) return;
    if (busy) {
      if (!onSteer) return;
      onSteer(t);
      setSteerSent(true);
      set('');
      return;
    }
    setSteerSent(false);
    onSend(t);
    set('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const steering = busy && !!onSteer;
  const empty = !text.trim();
  return (
    <div className={`kit-chat${className ? ` ${className}` : ''}`}>
      <form
        className="kit-composer"
        data-busy={busy || undefined}
        data-mood={mood || undefined}
        data-compact={compact || undefined}
        data-testid="kit-composer"
        onSubmit={e => { e.preventDefault(); submit(); }}
      >
        {edge != null && edge !== false && <span className="kit-composer-edge" aria-hidden="true" data-testid="kit-composer-edge">{edge}</span>}
        {leading != null && leading !== false && <div className="kit-composer-leading" data-testid="kit-composer-leading">{leading}</div>}
        <label htmlFor={inputId} className="kit-sr-only">{label}</label>
        <textarea
          id={inputId}
          ref={area}
          className="kit-composer-input"
          rows={2}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={e => set(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={steering ? busyPlaceholder : placeholder}
          aria-describedby={steering ? hintId : undefined}
          data-testid="kit-composer-input"
        />
        {steering && (
          <p id={hintId} className="kit-steer-hint" aria-live="polite">
            {steerSent ? 'Sent. It applies at the next step.' : 'What you send now applies at the next step.'}
          </p>
        )}
        <div className="kit-toolbar">
          <div className="kit-toolbar-slot" data-slot="scope">{scope}</div>
          {tools && <div className="kit-toolbar-slot" data-slot="tools">{tools}</div>}
          {tier && <div className="kit-toolbar-slot" data-slot="tier">{tier}</div>}
          {actions != null && actions !== false && <div className="kit-toolbar-slot" data-slot="actions">{actions}</div>}
          {busy && !(steering && !empty) ? (
            <button type="button" className="kit-stop" aria-label="Stop" disabled={!onStop} onClick={() => onStop?.()} data-testid="kit-stop">
              <span aria-hidden="true" className="kit-stop-mark" />
            </button>
          ) : (
            <button
              type="submit"
              className="kit-send"
              aria-label={steering ? 'Steer' : 'Send'}
              // Not dimmed: a faded arrow fails contrast. Assistive tech hears it; submit() ignores it.
              aria-disabled={disabled || empty ? true : undefined}
              data-testid="kit-send"
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </form>
      {showFormFallback && (formFallback ?? (formFallbackHref ? (
        <a className="kit-form-fallback" href={formFallbackHref} data-testid="kit-form-fallback">{formFallbackLabel}</a>
      ) : null))}
      {footer != null && footer !== false && <div className="kit-composer-footer" data-testid="kit-composer-footer">{footer}</div>}
    </div>
  );
});
