/**
 * Square corners: the brand radius is 0 (.claude/skills/ui_designer, "Square
 * Everything"). tailwind.config.ts zeroes the whole `rounded-*` scale, so
 * `rounded`, `rounded-lg` and `rounded-full` all render square. An arbitrary
 * value (`rounded-[10px]`, `rounded-r-[10px]`) bypasses that scale and draws a
 * real curve, which is how the Home "In flight" and action cards came out
 * rounded against square neighbours.
 *
 * No `rounded*-[...]` token may appear in app source, except in the chat
 * conversation layer (see isSoftConversationSurface below).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Glob } from 'bun';

const SRC = join(import.meta.dir, '..');

/** `rounded-[10px]`, `rounded-r-[10px]`, `rounded-tl-[6px]`, `md:rounded-[8px]` … */
const ARBITRARY_RADIUS = /(?<![\w-])(?:[\w-]+:)*rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-\[[^\]\s]+\]/g;

export function arbitraryRadiusTokens(line: string): string[] {
  return [...line.matchAll(ARBITRARY_RADIUS)].map(m => m[0]);
}

describe('arbitraryRadiusTokens', () => {
  it('finds bare and side-specific arbitrary radii, with variants', () => {
    expect(arbitraryRadiusTokens('className="rounded-[10px] px-4"')).toEqual(['rounded-[10px]']);
    expect(arbitraryRadiusTokens('border-l-2 rounded-r-[10px]')).toEqual(['rounded-r-[10px]']);
    expect(arbitraryRadiusTokens('md:rounded-tl-[6px]')).toEqual(['md:rounded-tl-[6px]']);
  });

  it('leaves the zeroed scale alone', () => {
    expect(arbitraryRadiusTokens('rounded rounded-full rounded-lg rounded-r-md')).toEqual([]);
  });
});

/**
 * The one deliberate exception: the chat conversation layer is soft by design
 * (docs/design/agent-chat.md, the canvas: "soft, unboxed conversation; hard
 * fleet objects"). Only a line styled with the conversation tokens (`--convo-*`)
 * may round, such as a user message bubble or the composer's workspace chip.
 * Fleet objects rendered inside chat (components/chat/objects/) stay square like
 * everywhere else. UI controls in chat files (like the floating Ask button) that
 * don't use convo tokens must stay square.
 */
export function isSoftConversationSurface(file: string, line: string): boolean {
  return line.includes('var(--convo-');
}

describe('isSoftConversationSurface', () => {
  it('allows only lines styled with conversation tokens, not other files or fleet objects', () => {
    expect(isSoftConversationSurface('components/chat/ChatFeed.tsx', 'md:rounded-[18px] md:bg-[var(--convo-me)]')).toBe(true);
    expect(isSoftConversationSurface('components/chat/objects/MissionObject.tsx', 'rounded-[8px]')).toBe(false);
    expect(isSoftConversationSurface('components/WorkspaceSwitcher.tsx', 'rounded-[999px] bg-[var(--convo-soft)]')).toBe(true);
    expect(isSoftConversationSurface('components/chat/ChatCanvas.tsx', 'rounded-[999px] border-[var(--on-accent)]')).toBe(false);
    expect(isSoftConversationSurface('app/app/(protected)/home/page.tsx', 'rounded-[10px]')).toBe(false);
  });
});

describe('square corners', () => {
  it('no source file outside the conversation layer uses an arbitrary border radius', () => {
    const hits: string[] = [];
    for (const f of new Glob('**/*.{ts,tsx}').scanSync(SRC)) {
      if (/\.test\.tsx?$/.test(f) || f.includes('/__tests__/')) continue;
      readFileSync(join(SRC, f), 'utf8').split('\n').forEach((line, i) => {
        if (isSoftConversationSurface(f, line)) return;
        for (const t of arbitraryRadiusTokens(line)) hits.push(`${f}:${i + 1} ${t}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
