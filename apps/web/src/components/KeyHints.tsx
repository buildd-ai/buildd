'use client';

/**
 * Keyboard hints, off by default. Not everyone building with buildd is an
 * engineer, so keycap chips (1/2/3, Esc, the chat shortcut) stay hidden unless
 * the person turns on "Show keyboard hints" (Settings -> Profile, stored on
 * `users.show_keyboard_hints`). The shortcuts themselves always work; only the
 * chips are gated.
 *
 * The protected layout provides the value from the session user. Pages outside
 * it (the dev fixtures) read `?hints=1`.
 */
import { createContext, useContext, type ReactNode } from 'react';

const KeyHintsContext = createContext(false);

export function KeyHintsProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <KeyHintsContext.Provider value={value}>{children}</KeyHintsContext.Provider>;
}

/** True when this person asked to see keycap hints. */
export function useKeyHints(): boolean {
  return useContext(KeyHintsContext);
}

/** The fixtures pages' `?hints=1`. Pure. */
export function keyHintsFromQuery(q: URLSearchParams | null): boolean {
  const v = q?.get('hints');
  return v === '1' || v === 'on' || v === 'true';
}

export const KBD_CLASS =
  'inline-grid min-w-[22px] h-5 place-items-center border-[1.5px] border-b-[3px] border-border-strong bg-surface-2 px-1.5 font-mono text-[11px] font-semibold leading-none text-text-secondary';

/** A keycap, only with hints on. `tone="accent"` sits on an orange button. */
export function Kbd({ children, className = '', tone = 'default' }: { children: ReactNode; className?: string; tone?: 'default' | 'accent' }) {
  const on = useKeyHints();
  if (!on) return null;
  const toneCls = tone === 'accent' ? '!border-[var(--on-accent)] !bg-transparent !text-[var(--on-accent)]' : '';
  return (
    <kbd data-testid="key-hint" aria-hidden="true" className={`${KBD_CLASS} ${toneCls} ${className}`}>
      {children}
    </kbd>
  );
}

/** Any hint copy ("Press 1 or 2 to answer", "⌘↵ to save"), only with hints on. */
export function KeyHintsOnly({ children }: { children: ReactNode }) {
  return useKeyHints() ? <>{children}</> : null;
}
