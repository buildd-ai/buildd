/**
 * The task sheet's history model (docs/design/mission-feed-mobile-continuity.md,
 * "Interaction, URL and scroll model" and W5). AC-7 (open is pushState, never
 * the router), AC-8 (step is replaceState; Back closes; a deep-linked sheet
 * closes with replaceState to `#t-<id>`) and AC-10 (every task row opens).
 */
import { describe, expect, it } from 'bun:test';
import {
  createTaskSheetHistory,
  readTaskParam,
  resolveTaskOpen,
  sheetUrl,
  closedSheetUrl,
  type ClickNode,
  type TaskSheetHistoryDeps,
} from './task-sheet-history';

const A = '0a1b2c3d-1111-4222-8333-444455556666';
const B = '0a1b2c3d-7777-4888-9999-aaaabbbbcccc';

function fakeHistory(initial: string) {
  const entries: string[] = [initial];
  let at = 0;
  const calls: Array<{ op: 'push' | 'replace' | 'back'; url?: string; data?: unknown }> = [];
  const loc = () => {
    const u = new URL(entries[at], 'https://example.invalid');
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  };
  const deps: TaskSheetHistoryDeps = {
    history: {
      state: { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: {}, mine: 1 },
      pushState: (data, _t, url) => {
        calls.push({ op: 'push', url: String(url), data });
        entries.splice(at + 1, entries.length, String(url));
        at++;
      },
      replaceState: (data, _t, url) => {
        calls.push({ op: 'replace', url: String(url), data });
        entries[at] = String(url);
      },
      back: () => {
        calls.push({ op: 'back' });
        if (at > 0) at--;
      },
    },
    location: loc,
  };
  const forward = () => { if (at < entries.length - 1) at++; };
  return { deps, calls, forward, current: () => entries[at], entries: () => entries.slice() };
}

describe('URL helpers', () => {
  it('sheetUrl sets task, keeps the rest of the query, and drops any #t- focus hash', () => {
    expect(sheetUrl({ pathname: '/app/missions/m1', search: '?from=home', hash: '#t-x' }, A))
      .toBe(`/app/missions/m1?from=home&task=${A}`);
  });

  it('closedSheetUrl drops task and lands focus on the row', () => {
    expect(closedSheetUrl({ pathname: '/app/missions/m1', search: `?from=home&task=${A}`, hash: '' }, A))
      .toBe(`/app/missions/m1?from=home#t-${A}`);
    expect(closedSheetUrl({ pathname: '/app/missions/m1', search: `?task=${A}`, hash: '' }, A))
      .toBe(`/app/missions/m1#t-${A}`);
  });

  it('readTaskParam rejects malformed ids so they cannot open a 404 sheet', () => {
    expect(readTaskParam(`?task=${A}`)).toBe(A);
    expect(readTaskParam('?task=abc')).toBeNull();
    expect(readTaskParam('')).toBeNull();
  });
});

describe('open → pushState (AC-7)', () => {
  it('pushes ?task= and never passes Next’s internal markers', () => {
    const h = fakeHistory('/app/missions/m1?from=home');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    expect(h.calls).toEqual([{ op: 'push', url: `/app/missions/m1?from=home&task=${A}`, data: { mine: 1 } }]);
  });

  it('opening while a sheet is already open replaces instead of stacking entries', () => {
    const h = fakeHistory('/app/missions/m1');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    sheet.open(B);
    expect(h.calls.map(c => c.op)).toEqual(['push', 'replace']);
  });
});

describe('step ‹ › → replaceState, Back closes (AC-8)', () => {
  it('step replaces the entry, so one Back leaves the sheet rather than walking siblings', () => {
    const h = fakeHistory('/app/missions/m1');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    sheet.step(B);
    expect(h.calls.map(c => c.op)).toEqual(['push', 'replace']);
    expect(h.current()).toBe(`/app/missions/m1?task=${B}`);
    sheet.close(B);
    expect(h.calls.at(-1)).toEqual({ op: 'back' });
    expect(h.current()).toBe('/app/missions/m1');
  });

  it('a pushed sheet closes with history.back()', () => {
    const h = fakeHistory('/app/missions/m1?from=home');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    sheet.close(A);
    expect(h.calls.map(c => c.op)).toEqual(['push', 'back']);
  });

  it('entered with ?task= (a deep link): close replaces to no task + #t-<id>, never back() out of the mission', () => {
    const h = fakeHistory(`/app/missions/m1?from=home&task=${A}`);
    const sheet = createTaskSheetHistory(h.deps);
    sheet.close(A);
    expect(h.calls).toEqual([{ op: 'replace', url: `/app/missions/m1?from=home#t-${A}`, data: { mine: 1 } }]);
  });

  it('after a system Back closed the sheet, the next open pushes a fresh entry again', () => {
    const h = fakeHistory('/app/missions/m1');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    h.deps.history.back();
    sheet.onPopState();
    sheet.open(B);
    sheet.close(B);
    expect(h.calls.map(c => c.op)).toEqual(['push', 'back', 'push', 'back']);
  });

  it('known limit: after a remount on a pushed sheet entry (Open full page → Back), close replaces', () => {
    // Session 1: list → open (push) → the user leaves for the task page.
    const h = fakeHistory('/app/missions/m1');
    createTaskSheetHistory(h.deps).open(A);
    expect(h.entries()).toEqual(['/app/missions/m1', `/app/missions/m1?task=${A}`]);

    // Back from the task page remounts the mission on the sheet entry: a fresh
    // model cannot know the entry was pushed, so ✕ replaces instead of back().
    const remounted = createTaskSheetHistory(h.deps);
    remounted.close(A);
    expect(h.calls.at(-1)).toEqual({ op: 'replace', url: `/app/missions/m1#t-${A}`, data: { mine: 1 } });
    // The pre-push entry is still behind it: one extra Back, nothing broken.
    expect(h.entries()).toEqual(['/app/missions/m1', `/app/missions/m1#t-${A}`]);
  });

  it('Forward back into a sheet entry pushed from the list still closes with back()', () => {
    const h = fakeHistory('/app/missions/m1');
    const sheet = createTaskSheetHistory(h.deps);
    sheet.open(A);
    h.deps.history.back();
    sheet.onPopState(); // Back → no task
    h.forward();
    sheet.onPopState(); // Forward → the pushed sheet entry
    expect(h.current()).toBe(`/app/missions/m1?task=${A}`);
    sheet.close(A);
    expect(h.calls.at(-1)).toEqual({ op: 'back' });
    expect(h.current()).toBe('/app/missions/m1');
  });
});

/** A fake DOM node: a tag, attributes and a parent — all the resolver walks. */
function node(tagName: string, attrs: Record<string, string>, parent: ClickNode | null = null): ClickNode {
  return { tagName, parentElement: parent, getAttribute: k => attrs[k] ?? null };
}
const click = (target: ClickNode, over: Partial<Parameters<typeof resolveTaskOpen>[0]> = {}) =>
  resolveTaskOpen({ target: target as unknown as EventTarget, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over });

describe('which clicks open the sheet (AC-10)', () => {
  it('a tap anywhere on a MissionTaskRow (the row is itself the <a>) opens that task', () => {
    const row = node('A', { href: `/app/missions/m1?task=${A}`, 'data-task-id': A, 'data-testid': 'mission-task-row' });
    expect(click(row)).toBe(A);
    expect(click(node('SPAN', {}, node('SPAN', {}, row)))).toBe(A);
  });

  it('a completed task with no PR opens the sheet too — data-task-actionable="false" is not an opt-out', () => {
    const row = node('DIV', { 'data-task-id': A, 'data-task-actionable': 'false' });
    expect(click(node('SPAN', {}, row))).toBe(A);
  });

  it('a legacy row’s title <Link> to the task page opens the sheet instead of navigating', () => {
    const row = node('DIV', { 'data-task-id': A, 'data-task-actionable': 'false' });
    const title = node('A', { href: `/app/tasks/${A}` }, row);
    expect(click(node('SPAN', {}, title))).toBe(A);
  });

  it('other controls inside a row keep their own behaviour (PR link, retry, attempts)', () => {
    const row = node('DIV', { 'data-task-id': A });
    expect(click(node('A', { href: 'https://github.com/o/r/pull/1', target: '_blank' }, row))).toBeNull();
    expect(click(node('SPAN', {}, node('BUTTON', {}, row)))).toBeNull();
    expect(click(node('SUMMARY', {}, row))).toBeNull();
    expect(click(node('A', { href: `/app/tasks/${B}` }, row))).toBeNull();
  });

  it('modified and non-primary clicks fall through to the real link (new tab, middle-click)', () => {
    const row = node('A', { href: `/app/missions/m1?task=${A}`, 'data-task-id': A });
    expect(click(row, { metaKey: true })).toBeNull();
    expect(click(row, { ctrlKey: true })).toBeNull();
    expect(click(row, { shiftKey: true })).toBeNull();
    expect(click(row, { button: 1 })).toBeNull();
    expect(click(row, { defaultPrevented: true })).toBeNull();
  });

  it('a pulse segment is not a row: the pulse owns its taps (focus first, open on the second)', () => {
    const pulse = node('DIV', { 'data-testid': 'mission-pulse' });
    const seg = node('BUTTON', { 'data-testid': 'mission-pulse-segment', 'data-task-id': A }, pulse);
    expect(click(seg)).toBeNull();
    expect(click(node('SPAN', {}, seg))).toBeNull();
  });

  it('nothing opens outside a task, or for a malformed id', () => {
    expect(click(node('DIV', {}))).toBeNull();
    expect(click(node('DIV', { 'data-task-id': 'nope' }))).toBeNull();
  });
});
