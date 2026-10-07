/**
 * The chat canvas, mounted (happy-dom): the composer sweep is the one glow and
 * runs only while a turn streams, the sea follows the mood, the empty canvas
 * greets and offers one-tap questions, the mission the chat is about pins as
 * a compact live board, and keyboard hints stay hidden unless the person
 * turned them on.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** buildd's look for the kit's composer and thread lives in globals.css, not in class names. */
const GLOBALS = readFileSync(join(import.meta.dir, '..', '..', 'app', 'globals.css'), 'utf8');
const ruleOf = (selector: string, from = 0) => { const i = GLOBALS.indexOf(`${selector} {`, from); return i < 0 ? '' : GLOBALS.slice(i, GLOBALS.indexOf('}', i)); };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/chat',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatWorkspace, ANCHOR_GAP } = await import('./ChatWorkspace');
const { ObjectStoreProvider } = await import('./objects/ObjectStoreProvider');
const { KeyHintsProvider } = await import('@/components/KeyHints');
const fixtures = await import('../../app/app/dev/chat/chat-fixtures');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
const sent: string[] = [];

beforeEach(() => {
  (window as any).matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  sent.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

type Props = Parameters<typeof ChatWorkspace>[0];

async function render(over: Partial<Props> = {}, opts: { hints?: boolean; state?: Parameters<typeof fixtures.fixtureViews>[0]; views?: Record<string, unknown>; pending?: boolean } = {}) {
  const views: Record<string, unknown> = { ...fixtures.fixtureViews(opts.state ?? 'split'), ...opts.views };
  const source = { load: async (r: { kind: string; id: string }) => {
    // `pending`: objects that never arrive, so cards stay in their loading slot.
    if (opts.pending) return new Promise<never>(() => {});
    const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v;
  } };
  const props: Props = {
    messages: [], status: 'ready', onSend: (t: string) => { sent.push(t); }, onApproval() {},
    title: null, agent: fixtures.ORGANIZER, tier: 'standard', workspaces: fixtures.WORKSPACES,
    workspaceId: fixtures.WS.id, onWorkspaceChange() {}, viewerName: 'Maya', ...over,
  };
  await act(async () => {
    root.render(
      <KeyHintsProvider value={opts.hints ?? false}>
        <ObjectStoreProvider source={source}>
          <ChatWorkspace {...props} />
        </ObjectStoreProvider>
      </KeyHintsProvider>,
    );
  });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

const q = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...container.querySelectorAll(sel)] as HTMLElement[];

describe('thinking', () => {
  const msgs = () => fixtures.chatFixture('streaming').messages;
  const glows = () => qa('[data-glow="true"]');
  const placeholder = () => (q('#chat-composer-input') as HTMLTextAreaElement).placeholder;

  it('one glow only: the composer sweep, and only while a turn is in flight', async () => {
    await render({ messages: msgs(), status: 'streaming' });
    expect(glows().map(g => g.dataset.testid)).toEqual(['composer-sweep']);
    expect(q('[data-testid="chat-composer"]')!.contains(glows()[0])).toBe(true);
    await render({ messages: msgs(), status: 'submitted' });
    expect(glows()).toHaveLength(1);
    await render({ messages: msgs(), status: 'ready' });
    expect(glows()).toHaveLength(0);
    expect(q('[data-testid="canvas-scan"]')).toBeNull();
  });

  it('while busy the composer invites steering and send becomes Stop', async () => {
    await render({ messages: msgs(), status: 'streaming', onStop() {} });
    expect(placeholder()).toBe('Steer while I think…');
    expect(q('[data-testid="kit-stop"]')).not.toBeNull();
    expect(q('[data-testid="kit-send"]')).toBeNull();
  });

  it('the streaming turn is one live line: the current step in plain words, no header, no tool names', async () => {
    await render({ messages: msgs(), status: 'streaming' });
    // The streaming message: the live line, then what the agent says.
    const panel = q('.buildd-thread .kit-msg[data-streaming]');
    expect(panel).not.toBeNull();
    expect(panel!.querySelector('.buildd-thinking-title')).toBeNull();
    expect(panel!.querySelector('[data-testid="kit-thinking-live"] .kit-live-label')?.textContent).toBe('Searching what buildd remembers');
    expect(qa('.buildd-thread li.kit-step')).toHaveLength(0);
    expect(panel!.textContent).not.toMatch(/manage_missions|recall\b/);
    expect(q('[data-testid="tool-call-row"]')).toBeNull();
    expect(panel!.querySelector('.stream-caret')).not.toBeNull();
  });

  it('the person\'s message carries a tiny tag naming where the turn went', async () => {
    await render({ messages: msgs(), status: 'streaming' });
    expect(q('[data-testid="feed-intent-tag"]')?.textContent).toBe('routed · billing-web');
  });

  it('send is the Stop block for the whole turn, even where nothing can stop it yet', async () => {
    await render({ messages: msgs(), status: 'streaming' });
    const stop = q('[data-testid="kit-stop"]') as HTMLButtonElement | null;
    expect(stop).not.toBeNull();
    expect(stop!.disabled).toBe(true);
    expect(q('[data-testid="kit-send"]')).toBeNull();
    expect(q('[data-testid="composer-sweep"]')).not.toBeNull();
  });

  it('once the turn lands its steps and tool rows fold to one line, and the answer stays open', async () => {
    await render({ messages: msgs(), status: 'ready' });
    const fold = q('[data-testid="kit-thinking"]') as HTMLDetailsElement;
    expect(fold.dataset.settled).toBe('true');
    expect(fold.open).toBe(false);
    expect(fold.querySelector('[data-testid="kit-thinking-summary"]')?.textContent).toBe('Did 2 steps');
    expect(q('[data-testid="tool-call-row"]')).toBeNull();
    expect(q('[data-testid="feed-text"]')).not.toBeNull();
    await act(async () => { fold.open = true; });
    expect(q('[data-testid="tool-call-row"]')).not.toBeNull();
  });

  it('submitted, nothing streamed: the pulsing square alone, no words', async () => {
    await render({ messages: msgs().slice(0, 1), status: 'submitted' });
    const line = q('.buildd-thread [data-testid="kit-thinking-live"]');
    expect(line?.querySelector('.kit-step-mark')).not.toBeNull();
    expect(q('.buildd-thread [data-testid="kit-thinking"]')!.textContent).toBe('');
  });
});

describe('phone layout: hero on top, open sea, PICKED FOR YOU right above the composer', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
  for (const pulse of [{ needsYou: [], live: 0 }, { needsYou: [{ title: 'Pick a currency' }], live: 0 }]) {
    it(`${pulse.needsYou.length ? 'needs-you' : 'calm'}: the panel is the last thing in a full-height column, after a growing gap`, async () => {
      await render({ pulse });
      const canvas = q('[data-testid="canvas-empty"]')!;
      expect(canvas.dataset.layout).toBe('anchored');
      expect(cls(canvas)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'max-lg:flex-1']));
      // The kit's box fills the column; its rows header is pushed to the
      // bottom (margin-top: auto, globals.css), and the rows are last.
      const box = canvas.querySelector('.kit-empty')!;
      expect(cls(box)).toEqual(expect.arrayContaining(['buildd-empty', 'buildd-empty-anchor-phone', 'flex', 'flex-col', 'max-lg:flex-1']));
      const head = box.querySelector('.kit-chips-head')!;
      expect(head.contains(q('[data-testid="canvas-suggestions"]'))).toBe(true);
      expect(head.nextElementSibling?.classList.contains('kit-chips')).toBe(true);
      expect(head.nextElementSibling?.nextElementSibling).toBeNull();
      expect(cls(canvas.parentElement)).toEqual(expect.arrayContaining(['max-lg:flex', 'max-lg:min-h-full', 'max-lg:flex-col']));
    });
  }

  it('a scoped chat and a thread keep the flowing layout', async () => {
    await render({ entryIntent: 'mission' });
    expect(q('[data-testid="canvas-empty"]')?.dataset.layout).toBeUndefined();
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    expect(cls(q('[data-testid="chat-feed"]')?.parentElement ?? null)).not.toContain('max-lg:min-h-full');
  });
});

describe('needs-input banner on the phone canvas', () => {
  it('the needs-you empty canvas holds the banner off on a phone; calm and a thread do not', async () => {
    const { phoneBannerHiddenSnapshot } = await import('@/lib/needs-input-hidden');
    await render({ pulse: { needsYou: [{ title: 'Round per line' }], live: 0 } });
    expect(phoneBannerHiddenSnapshot()).toBe(true);
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(phoneBannerHiddenSnapshot()).toBe(false);
    await render({ pulse: { needsYou: [{ title: 'Round per line' }], live: 0 }, messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    expect(phoneBannerHiddenSnapshot()).toBe(false);
  });
});

describe('contrast over the sea (AA)', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);

  it('the phone header is the opaque bar colour, so pools never sit under its text', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(cls(q('[data-testid="chat-header"]'))).toContain('bg-[var(--chat-bar)]');
  });

  it('send stays a solid copper block with a dark arrow when the box is empty: disabled is not dimmed', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    const send = q('[data-testid="kit-send"]')!;
    expect(send.getAttribute('aria-disabled')).toBe('true');
    const rule = ruleOf('.buildd-composer .kit-send');
    expect(rule).toContain('background: var(--mood-needs-fill)');
    expect(rule).toContain('color: var(--on-mood-needs)');
    // Nothing dims it: only a hover brightens an enabled one.
    expect(GLOBALS).not.toMatch(/\.buildd-composer \.kit-send\[aria-disabled[^{]*\{[^}]*(opacity|brightness)/);
  });

  it('an empty send does nothing', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    await act(async () => { q('[data-testid="kit-send"]')!.click(); });
    expect(sent).toEqual([]);
  });

  it('the intent tag sits on its own ground chip in muted text, never dim text on the sea', async () => {
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    const tag = cls(q('[data-testid="feed-intent-tag"]'));
    expect(tag).toContain('bg-[var(--chat-ground)]');
    expect(tag).toContain('text-[var(--chat-muted)]');
  });

  it('the composer top rule is the strong rule (copper only when something needs you), focused or not, on a phone', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(q('[data-testid="chat-composer"] .buildd-composer > form.kit-composer')).not.toBeNull();
    expect(ruleOf('.buildd-composer > .kit-composer')).toContain('border-top: 2px solid var(--chat-rule-strong)');
    expect(ruleOf('.buildd-composer > .kit-composer[data-mood="needs"]')).toContain('var(--mood-needs)');
    // The focus rule turns the text colour only from 1024px: never on a phone or tablet.
    const focus = GLOBALS.indexOf('.buildd-composer > .kit-composer:not([data-mood="needs"]):focus-within');
    const lg = GLOBALS.indexOf('@media (min-width: 1024px) {\n    .buildd-composer > .kit-composer { border-left');
    expect(lg).toBeGreaterThan(0);
    expect(focus).toBeGreaterThan(lg);
    expect(focus).toBeLessThan(GLOBALS.indexOf('/* ── Pinned on the kit', lg));
  });
});

describe('sea', () => {
  const sea = () => q('[data-testid="chat-sea"] .sea') as HTMLElement | null;

  it('one layer behind the page canvas, round pools, mood from the canvas', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(qa('[data-testid="chat-sea"]')).toHaveLength(1);
    expect(sea()?.dataset.mood).toBe('calm');
    expect(qa('[data-testid="sea-pool"]').length).toBeGreaterThanOrEqual(8);
    await render({ pulse: { needsYou: [{ title: 'Fix it' }], live: 0 } });
    expect(sea()?.dataset.mood).toBe('needs');
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming', pulse: { needsYou: [{ title: 'Fix it' }], live: 0 } });
    expect(sea()?.dataset.mood).toBe('thinking');
  });

  it('sits above the ground and below the content: the column is its own stacking context', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    const layer = q('[data-testid="chat-sea"]')!;
    const column = q('[data-testid="chat-column"]')!;
    expect(layer.parentElement).toBe(column);
    expect(column.className.split(/\s+/)).toContain('isolate');
    expect(layer.className.split(/\s+/)).toContain('-z-10');
    // Nothing between the layer and the column paints an opaque ground over it.
    expect(layer.className).not.toMatch(/\bbg-/);
  });

  it('holds still for reduced motion', async () => {
    await render();
    expect(sea()?.dataset.motion).toBe('static');
    (window as any).matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    expect(sea()?.dataset.motion).toBe('running');
  });

  it('the summoned overlay draws no sea', async () => {
    await render({ variant: 'overlay', onClose() {} });
    expect(q('[data-testid="chat-sea"]')).toBeNull();
  });
});

describe('empty canvas', () => {
  // The picked rows are the kit's ChatEmpty chips (rows variant); tone `needs` draws one copper.
  const chips = () => qa('[data-testid="canvas-empty"] .kit-chip');
  const labels = () => chips().map(c => c.textContent);
  const copper = (c: HTMLElement) => c.dataset.tone === 'needs';
  const placeholder = () => (q('#chat-composer-input') as HTMLTextAreaElement).placeholder;

  it('without a pulse: greets by name, claims no mood, and offers no needs-you prompt', async () => {
    await render();
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Hi Maya, what are we working on?');
    expect(q('[data-testid="canvas-empty"] .kit-mood-dot')).toBeNull();
    expect(labels()).toEqual(["What's running right now?", 'Start something new']);
    await act(async () => { chips()[0].click(); });
    expect(sent).toEqual(["What's running right now?"]);
  });

  it('calm: all quiet, exactly two picked rows, nothing copper, the top row is the placeholder', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('calm');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('All quiet.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('nothing blocked');
    expect(chips()).toHaveLength(2);
    expect(chips().filter(copper)).toHaveLength(0);
    expect(placeholder()).toBe('Start something new…');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('calm');
  });

  it('needs you: names it, row 1 is copper, the composer rule turns copper', async () => {
    await render({ pulse: { needsYou: [{ title: 'Pick a currency' }], live: 1 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('needs');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('One to review.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('1 blocked');
    // The overline leads with the needs square; the header reads before the rows.
    expect(q('[data-testid="canvas-empty"] .kit-empty-overline .kit-mood-dot')?.getAttribute('data-mood')).toBe('needs');
    expect(q('[data-testid="canvas-empty"] .kit-chips-head')?.nextElementSibling?.classList.contains('kit-chips')).toBe(true);
    const rows = chips();
    expect(rows).toHaveLength(2);
    expect(copper(rows[0])).toBe(true);
    expect(copper(rows[1])).toBe(false);
    expect(placeholder()).toBe('Answer the waiting question');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('needs');
    await act(async () => { rows[0].click(); });
    expect(sent).toEqual(['What does "Pick a currency" need from me?']);
  });

  it('a starter fills the box instead of sending', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    const starter = chips().find(c => c.textContent?.includes('Start something new'))!;
    await act(async () => { starter.click(); });
    expect(sent).toEqual([]);
    expect((q('#chat-composer-input') as HTMLTextAreaElement).value).toBe('I want to build ');
  });
});

// happy-dom applies no media queries, so the phone-only rules are asserted as
// the breakpoint classes that carry them (lg = 1024px: a tablet reads as a phone).
describe('phone chrome (v3 frames)', () => {
  const header = () => q('[data-testid="chat-header"]')!;

  it('a new chat: `CHAT / new` left, `HISTORY →` right, no back arrow on a phone', async () => {
    await render();
    const section = q('[data-testid="chat-mobile-section"]')!;
    expect(section.textContent).toBe('Chat');
    expect(section.className).not.toMatch(/(^|\s)(md|lg):hidden(\s|$)/);
    expect(section.className).toMatch(/uppercase/);
    expect(q('[data-testid="chat-title-mobile"]')?.textContent).toBe('new');
    const history = q('[data-testid="chat-history-link"]') as HTMLAnchorElement;
    expect(history.getAttribute('href')).toBe('/app/chat?view=history');
    expect(history.textContent).toBe('History →');
    expect(history.className).toMatch(/(^|\s)lg:hidden(\s|$)/);
    expect(header().querySelector('a[aria-label="All chats"]')).toBeNull();
    // HISTORY stands in for + New chat at every width.
    expect(q('[data-testid="chat-new"]')).toBeNull();
  });

  it('an open conversation keeps its title after `CHAT /`', async () => {
    await render({ title: 'Multi-currency invoices', messages: fixtures.chatFixture('streaming').messages });
    expect(q('[data-testid="chat-title-mobile"]')).toBeNull();
    expect(q('[data-testid="chat-title"]')?.textContent).toBe('Multi-currency invoices');
    expect(q('[data-testid="chat-history-link"]')).not.toBeNull();
  });

  it('the history view: `CHAT / history`, `NEW →`, the list shown on a phone and the hero hidden', async () => {
    await render({ historyOpen: true, emptyState: <nav data-testid="conversation-list" /> });
    expect(q('[data-testid="chat-title-mobile"]')?.textContent).toBe('history');
    const link = q('[data-testid="chat-history-link"]') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/app/chat');
    expect(link.textContent).toBe('New →');
    expect(q('[data-testid="chat-empty-state"]')?.className ?? '').not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(q('[data-testid="canvas-empty"]')?.className).toMatch(/max-lg:hidden/);
  });

  it('the new-chat canvas leaves "Pick up where you left off" to the history view', async () => {
    await render({ emptyState: <nav data-testid="conversation-list" /> });
    expect(q('[data-testid="chat-empty-state"]')).toBeNull();
    expect(q('[data-testid="canvas-empty"]')?.className).not.toMatch(/max-lg:hidden/);
  });

  it('the scope cell reads `@ all ▾` on a phone when every workspace is in scope', async () => {
    await render({ workspaceId: null });
    const chip = q('[data-testid="composer-scope-chip"]')!;
    const short = chip.querySelector('[data-testid="scope-chip-short"]')!;
    expect(short.textContent).toBe('all');
    expect(short.className).not.toMatch(/(md|lg):hidden/);
    expect(short.getAttribute('title')).toBe('All workspaces');
    expect(chip.querySelector('[data-testid="scope-chip-name"]')).toBeNull();
  });

  it('the overlay keeps its own header', async () => {
    await render({ variant: 'overlay', onClose() {} });
    expect(q('[data-testid="chat-history-link"]')).toBeNull();
    expect(q('[data-testid="chat-mobile-section"]')).toBeNull();
  });
});

describe('pinned object', () => {
  it('the mission the chat is about pins as a compact board', async () => {
    await render({ focusRef: fixtures.missionRef, focusOpensSheet: false, initialPaneClosed: true });
    const pin = q('.buildd-pinned');
    expect(pin?.dataset.kind).toBe('mission');
    expect(qa('[data-testid="canvas-mini-row"]').length).toBeGreaterThan(0);
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Ask anything about');
  });

  it('no object in the conversation: nothing pinned', async () => {
    await render();
    expect(q('.buildd-pinned')).toBeNull();
  });
});

describe('mission sheet (the summoned canvas over a mission)', () => {
  const overlay = (over: Partial<Props> = {}): Partial<Props> => ({
    variant: 'overlay', focusRef: fixtures.missionRef, focusOpensSheet: false, fullChatHref: '/app/chat?about=mission', onClose() {}, ...over,
  });
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;

  it('a 48px header: ASK / THIS MISSION, full screen, close; the title shows once, in the card', async () => {
    await render(overlay());
    const header = q('[data-testid="chat-header"]')!;
    expect(header.dataset.sheet).toBe('mission');
    expect(header.className).toContain('h-12');
    expect(q('[data-testid="sheet-crumbs"]')?.textContent).toBe('Ask/This mission');
    expect(q('[data-testid="canvas-full-chat"]')?.textContent).toBe('Full screen ↗');
    expect(q('[data-testid="canvas-full-chat"]')?.getAttribute('href')).toBe('/app/chat?about=mission');
    expect(q('[data-testid="canvas-close"]')).not.toBeNull();
    expect(q('.buildd-pinned')).toBeNull();
    expect(q('[data-testid="canvas-empty"]')).toBeNull();
    expect(q('[data-testid="mission-context-title"]')?.textContent).toBe('Multi-currency invoices');
    expect(count(container.textContent ?? '', 'Multi-currency invoices')).toBe(1);
    expect(q('[data-testid="chat-column"]')?.className).toContain('bg-[var(--chat-bar)]');
  });

  it('the context card: status badge, LANDED and GOAL counts, an insight line', async () => {
    await render(overlay());
    expect(q('[data-testid="mission-context-status"]')?.textContent).toBe('Needs you');
    expect(q('[data-testid="mission-context-landed-count"]')?.textContent).toMatch(/^\d+\/\d+$/);
    expect(q('[data-testid="mission-context-goal-count"]')?.textContent).toMatch(/^\d+\/\d+$/);
    expect(q('[data-testid="mission-context-insight"]')?.textContent).toMatch(/needs? input/);
    expect(q('[data-testid="mission-context-flag"]')).not.toBeNull();
  });

  it('complete with criteria unchecked: the copper flag, and row 1 asks why', async () => {
    const base = fixtures.missionView('live');
    const done = {
      ...base, status: 'completed', stateLabel: 'Complete',
      board: { ...base.board, complete: true, needsYou: [], live: 0, criteria: base.board.criteria.map(c => ({ ...c, state: 'pending' as const })) },
    };
    await render(overlay(), { views: { [`mission:${fixtures.missionRef.id}`]: done } });
    const n = base.board.criteria.length;
    expect(q('[data-testid="mission-context-insight"]')?.textContent).toBe(`Marked complete, but ${n} of ${n} goal criteria are unchecked.`);
    expect(q('[data-testid="mission-context-flag"]')).not.toBeNull();
    const rows = qa('[data-testid="canvas-suggestion"]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows[0].dataset.tone).toBe('needs');
    expect(rows[0].textContent).toContain(`Why are ${n} criteria unchecked?`);
    await act(async () => { rows[0].click(); });
    expect(sent[0]).toContain('marked complete');
  });

  it('the composer scope is locked to the mission and its workspace', async () => {
    await render(overlay());
    const cell = q('[data-testid="composer-scope-locked"]');
    // Phones show the workspace alone, wider screens `mission · <workspace>` (#3080).
    expect(cell?.querySelector('.hidden.md\\:inline')?.textContent).toBe(`mission · ${fixtures.WS.name}`);
    expect(cell?.querySelector('.md\\:hidden')?.textContent).toBe(fixtures.WS.name);
    expect(cell?.getAttribute('aria-label')).toBe(`Scope locked to mission · ${fixtures.WS.name}`);
    expect(q('[data-testid="composer-scope-lock"]')).not.toBeNull();
    expect(q('[data-testid="composer-scope-chip"]')).toBeNull();
  });

  it('after the first message the card gives way to the pinned strip', async () => {
    await render(overlay({ messages: fixtures.chatFixture('streaming').messages, status: 'ready' }));
    expect(q('[data-testid="mission-context-card"]')).toBeNull();
    expect(q('.buildd-pinned')).not.toBeNull();
  });

  it('desktop peek (docs/design/chat-v3-desktop.md): a 56px header, a solid panel, no sea', async () => {
    await render(overlay());
    const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
    expect(cls(q('[data-testid="chat-header"]'))).toContain('lg:h-14');
    expect(cls(q('[data-testid="chat-column"]'))).toContain('lg:bg-[var(--chat-bar)]');
    expect(q('[data-testid="chat-sea"]')).toBeNull();
  });

  it('desktop peek over any other page: the same v3 header, ASK / CHAT, the old header phone only', async () => {
    await render({ variant: 'overlay', onClose() {}, fullChatHref: '/app/chat' });
    const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
    const peek = q('[data-testid="chat-header-peek"]')!;
    expect(cls(peek)).toEqual(expect.arrayContaining(['hidden', 'lg:flex', 'lg:h-14']));
    expect(peek.querySelector('[data-testid="peek-crumbs"]')?.textContent).toBe('Ask/Chat');
    expect(peek.querySelector('[data-testid="peek-full-chat"]')?.getAttribute('href')).toBe('/app/chat');
    expect(peek.querySelector('[data-testid="peek-close"]')).not.toBeNull();
    expect(cls(q('[data-testid="chat-header"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="chat-column"]'))).toContain('lg:bg-[var(--chat-bar)]');
  });

  it('the page canvas keeps its own header and switcher', async () => {
    await render();
    expect(q('[data-testid="chat-header"]')?.dataset.sheet).toBeUndefined();
    expect(q('[data-testid="composer-scope-locked"]')).toBeNull();
  });
});

describe('keyboard hints', () => {
  it('are hidden by default and shown when turned on', async () => {
    await render();
    expect(q('[data-testid="composer-key-hints"]')).toBeNull();
    expect(q('[data-testid="key-hint"]')).toBeNull();
    await render({}, { hints: true });
    expect(q('[data-testid="composer-key-hints"]')).not.toBeNull();
  });
});

describe('thread scroll', () => {
  // Content cut off at the top edge showed as stray glyphs under the header.
  it('the top edge of the thread fades out', async () => {
    await render({ messages: fixtures.chatFixture('confirmed').messages });
    expect(q('[data-testid="chat-scroller"]')!.className).toContain('mask-image');
  });

  // happy-dom has no layout: the scroller is a 600px window at y=100 over
  // 3000px of content, and `place` says where a block sits in that content.
  const SCROLLER_TOP = 100;
  const VIEW = 600;
  const HEIGHT = 3000;
  let place: (el: Element) => { top: number; height: number } | null = () => null;
  const realRect = HTMLElement.prototype.getBoundingClientRect;
  const rect = (top: number, height: number) => ({ top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} }) as DOMRect;
  const scroller = () => q('[data-testid="chat-scroller"]')!;
  beforeEach(() => {
    place = () => null;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const sc = container.querySelector('[data-testid="chat-scroller"]') as HTMLElement | null;
      if (this === sc) return rect(SCROLLER_TOP, VIEW);
      const p = sc && place(this);
      return p ? rect(SCROLLER_TOP + p.top - sc.scrollTop, p.height) : rect(0, 0);
    };
  });
  afterEach(() => { HTMLElement.prototype.getBoundingClientRect = realRect; });
  /** Mount, then give the scroller its window and content height (happy-dom lays nothing out). */
  async function mount(over: Partial<Props>) {
    await render(over);
    const sc = scroller();
    Object.defineProperty(sc, 'scrollHeight', { configurable: true, get: () => HEIGHT });
    Object.defineProperty(sc, 'clientHeight', { configurable: true, get: () => VIEW });
  }
  const readerScrolls = async (top: number) => {
    await act(async () => { scroller().scrollTop = top; scroller().dispatchEvent(new Event('scroll')); });
  };
  const textOf = (el: Element, s: string) => el.matches('[data-testid="feed-text"]') && (el.textContent ?? '').includes(s);
  type Msg = Props['messages'][number];
  /**
   * The confirmed fixture's turn, still streaming its reply after the approval.
   * Each call adds a (non-visual) part too, as a real stream's chunks do, so
   * the thread sees new content.
   */
  let chunks = 0;
  const confirmedWith = (extra: string) => {
    chunks += 1;
    return fixtures.chatFixture('confirmed').messages.map((m: Msg) => (m.id === 'm4'
      ? { ...m, parts: [...m.parts.map(p => (p.type === 'text' && p.text.startsWith('Filed.') ? { ...p, text: p.text + extra, state: 'streaming' as const } : p)), ...Array.from({ length: chunks }, () => ({ type: 'step-start' as const }))] }
      : m));
  };

  it('Confirm: the reply after the card lands at the top of the view, and streaming does not yank it to the bottom', async () => {
    const approvals: Array<[string, boolean]> = [];
    await mount({ messages: fixtures.chatFixture('propose').messages, status: 'ready', onApproval: (id, ok) => { approvals.push([id, ok]); } });
    await act(async () => { (q('[data-testid="kit-approval-confirm"]') as HTMLButtonElement).click(); });
    expect(approvals).toEqual([['approval-1', true]]);
    // The reply sits 1800px into the thread.
    place = el => (textOf(el, 'Filed. buildd is planning') ? { top: 1800, height: 120 } : null);
    await render({ messages: confirmedWith(''), status: 'streaming' });
    expect(scroller().scrollTop).toBe(1800 - ANCHOR_GAP);
    // The card folded to its row in place, same wrapper.
    expect(q('[data-approval-id="approval-1"]')?.dataset.state).toBe('done');
    // More of the reply streams in: the view holds its head.
    await render({ messages: confirmedWith(' More words arrive.'), status: 'streaming' });
    expect(scroller().scrollTop).toBe(1800 - ANCHOR_GAP);
    await render({ messages: confirmedWith(' More words arrive. And more.'), status: 'ready' });
    expect(scroller().scrollTop).toBe(1800 - ANCHOR_GAP);
  });

  it('Discard anchors the same way: the reply to a discard is what to read next', async () => {
    await mount({ messages: fixtures.chatFixture('propose').messages, status: 'ready' });
    await act(async () => { (q('[data-testid="kit-approval-deny"]') as HTMLButtonElement).click(); });
    const denied = fixtures.chatFixture('denied').messages;
    const reply = denied.map((m: Msg) => (m.id === 'm4' ? { ...m, parts: [...m.parts, { type: 'text' as const, text: 'Dropped it. Nothing filed.', state: 'streaming' as const }] } : m));
    place = el => (textOf(el, 'Dropped it') ? { top: 1500, height: 40 } : null);
    await render({ messages: reply, status: 'streaming' });
    expect(scroller().scrollTop).toBe(1500 - ANCHOR_GAP);
  });

  it('a card of rows anchors the same way: the reply after it lands at the top of the view', async () => {
    await mount({ messages: fixtures.chatFixture('rows').messages, status: 'ready' });
    await act(async () => { (q('[data-testid="kit-approval-confirm"]') as HTMLButtonElement).click(); });
    // Each row carries its approval id, so the reply after the card is found as for one card.
    const done = fixtures.chatFixture('rows-done').messages.map((m: Msg) => (m.id === 'm4'
      ? { ...m, parts: m.parts.map(p => (p.type === 'text' && p.text.startsWith('Filed two') ? { ...p, state: 'streaming' as const } : p)) }
      : m));
    place = el => (textOf(el, 'Filed two') ? { top: 1600, height: 80 } : null);
    await render({ messages: done, status: 'streaming' });
    expect(scroller().scrollTop).toBe(1600 - ANCHOR_GAP);
  });

  it('the reader scrolling after Confirm wins, and scrolling back to the bottom resumes following', async () => {
    await mount({ messages: fixtures.chatFixture('propose').messages, status: 'ready' });
    await act(async () => { (q('[data-testid="kit-approval-confirm"]') as HTMLButtonElement).click(); });
    place = el => (textOf(el, 'Filed. buildd is planning') ? { top: 1800, height: 120 } : null);
    await render({ messages: confirmedWith(''), status: 'streaming' });
    await readerScrolls(1000);
    await render({ messages: confirmedWith(' More.'), status: 'streaming' });
    expect(scroller().scrollTop).toBe(1000);
    // Back at the bottom: it follows the stream again.
    await readerScrolls(HEIGHT - VIEW);
    await render({ messages: confirmedWith(' More. Again.'), status: 'streaming' });
    expect(scroller().scrollTop).toBe(HEIGHT);
  });

  it('while a turn streams it follows the bottom; the reader scrolling up stops that', async () => {
    const streaming = fixtures.chatFixture('streaming').messages;
    await mount({ messages: streaming, status: 'streaming' });
    const grow = (n: number) => streaming.map((m: Msg) => (m.id === 'm2' ? { ...m, parts: [...m.parts, ...Array.from({ length: n }, () => ({ type: 'step-start' as const }))] } : m));
    await render({ messages: grow(1), status: 'streaming' });
    expect(scroller().scrollTop).toBe(HEIGHT);
    await readerScrolls(900);
    await render({ messages: grow(2), status: 'streaming' });
    expect(scroller().scrollTop).toBe(900);
  });

  it('a finished reply taller than the view shows its head, not its tail', async () => {
    const streaming = fixtures.chatFixture('streaming').messages;
    await mount({ messages: streaming, status: 'streaming' });
    await render({ messages: [...streaming], status: 'submitted' });
    expect(scroller().scrollTop).toBe(HEIGHT);
    const done = streaming.map((m: Msg) => (m.id === 'm2' ? { ...m, parts: m.parts.map(p => (p.type === 'text' ? { ...p, state: 'done' as const } : p)) } : m));
    place = el => (textOf(el, 'Nothing in flight') ? { top: 2000, height: 900 } : null);
    await render({ messages: done, status: 'ready' });
    expect(scroller().scrollTop).toBe(2000 - ANCHOR_GAP);
  });

  it('a finished reply that fits stays at the bottom', async () => {
    const streaming = fixtures.chatFixture('streaming').messages;
    await mount({ messages: streaming, status: 'streaming' });
    const done = streaming.map((m: Msg) => (m.id === 'm2' ? { ...m, parts: m.parts.map(p => (p.type === 'text' ? { ...p, state: 'done' as const } : p)) } : m));
    place = el => (textOf(el, 'Nothing in flight') ? { top: 2800, height: 120 } : null);
    await render({ messages: done, status: 'ready' });
    expect(scroller().scrollTop).toBe(HEIGHT);
  });
});

describe('objects reserve their height while they load', () => {
  it('a loading card holds a slot at the card\'s height, so the reply under it does not move when it arrives', async () => {
    await render({ messages: fixtures.chatFixture('confirmed').messages }, { pending: true });
    const loading = q('[data-testid="object-card"][data-state="loading"][data-kind="mission"]');
    expect(loading).not.toBeNull();
    expect(loading!.hasAttribute('data-reserve')).toBe(true);
    expect(loading!.className).toMatch(/min-h-\[\d+px\]/);
  });

  it('a card whose object is gone keeps its one line: nothing is coming to fill a slot', async () => {
    await render({ messages: fixtures.chatFixture('confirmed').messages }, { views: { [`mission:${fixtures.MISSION_ID}`]: undefined } });
    const gone = q('[data-testid="object-card"][data-state="gone"]');
    expect(gone).not.toBeNull();
    expect(gone!.hasAttribute('data-reserve')).toBe(false);
  });
});

describe('desktop (>= 1024px): one 720px voice column over the sea (docs/design/chat-v3-desktop.md)', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
  const calm = { needsYou: [], live: 0 };

  it('the sea fills the stage on desktop too, over the chat ground', async () => {
    await render({ pulse: calm });
    const layer = cls(q('[data-testid="chat-sea"]'));
    expect(layer).not.toContain('md:hidden');
    expect(layer).not.toContain('hidden');
    expect(cls(q('[data-testid="chat-column"]'))).toContain('bg-[var(--chat-ground)]');
  });

  it('headline, messages, picked panel and composer share one centred 720px column', async () => {
    await render({ pulse: calm });
    const voice = q('[data-testid="chat-voice-column"]')!;
    expect(voice.parentElement?.dataset.testid).toBe('chat-scroller');
    expect(cls(voice)).toEqual(expect.arrayContaining(['mx-auto', 'lg:max-w-[720px]', 'lg:px-0']));
    const composerCol = q('[data-testid="chat-composer-column"]')!;
    expect(composerCol.contains(q('[data-testid="chat-composer"]'))).toBe(true);
    expect(cls(composerCol)).toEqual(expect.arrayContaining(['mx-auto', 'lg:max-w-[720px]']));
    // Text inside the column is capped at 640.
    expect(cls(q('[data-testid="canvas-hero-sub"]'))).toContain('lg:max-w-[640px]');
  });

  it('the picked panel sits just above the composer, as on a phone', async () => {
    await render({ pulse: calm });
    const canvas = q('[data-testid="canvas-empty"]')!;
    expect(cls(canvas)).toEqual(expect.arrayContaining(['flex', 'flex-col', 'lg:flex-1', 'lg:mb-0']));
    expect(cls(canvas.parentElement)).toEqual(expect.arrayContaining(['lg:flex', 'lg:min-h-full', 'lg:flex-col']));
    expect(cls(canvas.querySelector('.kit-empty'))).toEqual(expect.arrayContaining(['buildd-empty-anchor-desk', 'lg:flex-1']));
  });

  it('header: `CHAT / new` left and `HISTORY →` right, over the opaque bar; no agent crumbs, no + New chat', async () => {
    await render({ pulse: calm });
    expect(cls(q('[data-testid="chat-header"]'))).toContain('lg:bg-[var(--chat-bar)]');
    expect(cls(q('[data-testid="chat-mobile-section"]'))).not.toContain('lg:hidden');
    expect(q('[data-testid="chat-title-mobile"]')?.textContent).toBe('new');
    expect(q('[data-testid="canvas-crumbs-desktop"]')).toBeNull();
    expect(q('[data-testid="chat-title-desktop"]')).toBeNull();
    // Desktop: HISTORY opens the right panel instead of navigating.
    expect(cls(q('[data-testid="chat-history-link"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="chat-history-toggle"]'))).toEqual(expect.arrayContaining(['hidden', 'lg:inline-flex']));
    expect(q('[data-testid="chat-new"]')).toBeNull();
  });

  it('an open conversation reads `CHAT / <title>` in the phone style', async () => {
    await render({ title: 'Gift card retries', messages: fixtures.chatFixture('streaming').messages });
    const title = cls(q('[data-testid="chat-title"]'));
    expect(title).toEqual(expect.arrayContaining(['text-[13px]', 'text-[var(--chat-muted)]']));
    expect(title).not.toContain('font-semibold');
  });

  it('the calm canvas shows neither the RECENT list nor the form link; the history view shows the list', async () => {
    await render({ pulse: calm, emptyState: <nav data-testid="conversation-list" /> });
    expect(q('[data-testid="chat-empty-state"]')).toBeNull();
    expect(q('[data-testid="chat-form-fallback"]')).toBeNull();
    // The history view on desktop: the list opens in the right panel, the canvas stays.
    await render({ historyOpen: true, emptyState: <nav data-testid="conversation-list" />, aside: <nav data-testid="history-list" /> });
    expect(cls(q('[data-testid="chat-empty-state"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="canvas-empty"]'))).not.toContain('lg:hidden');
    expect(q('[data-testid="chat-dock"]')?.dataset.mode).toBe('history');
  });

  it('the composer holds its edge over the sea: 1px border, 4px offset shadow, cells 64 / 88 / 64', async () => {
    await render({ pulse: calm, workspaceId: null, teamId: 'team-1' });
    expect(q('[data-testid="kit-send"]')).not.toBeNull();
    const lg = GLOBALS.indexOf('.buildd-composer > .kit-composer { box-shadow: 4px 4px 0 0 var(--chat-rule); }');
    expect(lg).toBeGreaterThan(GLOBALS.lastIndexOf('@media (min-width: 1024px)', lg) - 1);
    expect(GLOBALS.slice(lg, lg + 200)).toContain('.buildd-composer .kit-send, .buildd-composer .kit-stop { width: 64px; }');
    expect(GLOBALS).toContain('.buildd-composer > .kit-composer { border-left: 1px solid var(--chat-rule); border-right: 1px solid var(--chat-rule); border-bottom: 1px solid var(--chat-rule); }');
    expect(cls(q('[data-testid="composer-tools-cell"]'))).toContain('lg:w-16');
    // The scope cell reads `@ all` as on the frame.
    expect(q('[data-testid="scope-chip-short"]')?.textContent).toBe('all');
    expect(q('[data-testid="scope-chip-name"]')).toBeNull();
  });

  it('the person\'s message is the square phone bubble, not the rounded one', async () => {
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    const bubble = cls(q('[data-testid="feed-user-bubble"]'));
    expect(bubble).toEqual(expect.arrayContaining(['border', 'bg-[var(--chat-raised)]', 'font-voice', 'lg:max-w-[590px]']));
    expect(bubble.some(c => /rounded/.test(c))).toBe(false);
  });

  it('the old 400px context aside is gone everywhere: the right panel replaces it', async () => {
    await render({ pulse: calm, aside: <div data-testid="old-aside" /> });
    expect(q('[data-testid="chat-aside"]')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render({ messages: fixtures.chatFixture('confirmed').messages, initialPaneClosed: true, aside: <div data-testid="old-aside" /> });
    expect(q('[data-testid="chat-aside"]')).toBeNull();
    expect(cls(q('[data-testid="chat-column"]'))).toContain('flex-1');
  });
});
describe('desktop right panel (>= 1024px, docs/design/chat-v3-desktop.md "Dock")', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
  const NEED_TASK = 'task-need';
  const needTask = {
    kind: 'task', id: NEED_TASK, workspaceId: fixtures.WS.id, title: 'feat(receipts): totals in the buyer currency', scope: 'receipts', label: 'totals in the buyer currency',
    status: 'in_progress', roleName: 'Builder', roleColor: null, missionId: null, missionTitle: null,
    worker: { id: 'w-need', status: 'waiting_input', runner: 'atlas', startedAt: 1, completedAt: null, currentAction: null, waiting: true, prNumber: null, prUrl: null, mergedAt: null, prLifecycleStatus: null, turns: 9, updatedAt: 2 },
    now: null, renderedAt: 3, attempts: 2, waitingPrompt: 'Round per line, or only the total?',
    happened: [{ ts: Date.parse('2026-09-27T09:12:00'), text: 'Started the change' }],
  };
  const needs = { needsYou: [{ title: 'Totals in the buyer currency', action: 'Answer the rounding question', taskId: NEED_TASK, workspaceId: fixtures.WS.id }], live: 1 };
  const views = { [`task:${NEED_TASK}`]: needTask };
  const fresh = () => { act(() => root.unmount()); root = createRoot(container); };
  beforeEach(() => { window.sessionStorage.clear(); });

  it('a docked mission: a solid 420px panel on the right, ABOUT / MISSION, the v3 card and who is at work', async () => {
    await render({ focusRef: fixtures.missionRef }, { state: 'split' });
    const dock = q('[data-testid="chat-dock"]')!;
    expect(dock.dataset.mode).toBe('object');
    expect(cls(dock)).toEqual(expect.arrayContaining(['hidden', 'lg:flex', 'lg:w-[420px]', 'bg-[var(--chat-bar)]']));
    expect(q('[data-testid="chat-dock-crumbs"]')?.textContent).toMatch(/About\s*\/\s*Mission/i);
    expect(dock.querySelector('[data-testid="mission-context-card"]')).not.toBeNull();
    expect(dock.querySelector('[data-testid="dock-at-work"]')).not.toBeNull();
    expect(dock.querySelector('[data-testid="dock-open"]')?.getAttribute('href')).toBe(`/app/missions/${fixtures.missionRef.id}`);
    // The dock follows the column; there is no side-by-side tablet pane.
    expect(dock.previousElementSibling?.getAttribute('data-testid')).toBe('chat-column');
    expect(q('[data-testid="chat-pane"]')).toBeNull();
    // The chat keeps its centred 720px column beside the dock (no 540px chat).
    expect(cls(q('[data-testid="chat-column"]'))).toContain('flex-1');
    expect(cls(q('[data-testid="chat-column"]')).some(c => c.includes('540px'))).toBe(false);
    expect(cls(q('[data-testid="chat-voice-column"]'))).toContain('lg:max-w-[720px]');
    expect(cls(q('[data-testid="chat-composer-column"]'))).toContain('lg:max-w-[720px]');
  });

  it('closing the dock closes the object', async () => {
    await render({ focusRef: fixtures.missionRef });
    await act(async () => { (q('[data-testid="dock-close"]') as HTMLButtonElement).click(); });
    expect(q('[data-testid="chat-dock"]')).toBeNull();
  });

  it('needs you at >= 1280px: the blocked task docks with its badge, tries, question, what happened and actions', async () => {
    await render({ pulse: needs }, { views });
    const dock = q('[data-testid="chat-dock"]')!;
    expect(dock.dataset.mode).toBe('needs');
    expect(cls(dock)).toEqual(expect.arrayContaining(['hidden', 'xl:flex']));
    expect(cls(dock)).not.toContain('lg:flex');
    expect(q('[data-testid="chat-dock-crumbs"]')?.textContent).toMatch(/Needs you\s*\/\s*Task/i);
    expect(q('[data-testid="dock-task-badge"]')?.textContent).toBe('Needs you');
    expect(q('[data-testid="dock-task-title"]')?.className).toContain('font-voice');
    expect(q('[data-testid="dock-task-tries"]')?.textContent).toContain('2');
    expect(q('[data-testid="dock-task-insight"]')?.textContent).toContain('Round per line');
    const steps = qa('[data-testid="dock-happened-row"]').map(r => r.textContent);
    expect(steps[0]).toContain('Started the change');
    expect(steps.at(-1)).toContain('Needs input.');
    expect(qa('[data-testid="dock-action"]').map(b => b.textContent)).toEqual(['Answer it', 'Ask about it']);
  });

  it('below 1280px the blocker shows in the pinned strip instead', async () => {
    await render({ pulse: needs }, { views });
    const pin = q('.buildd-pinned[data-kind="task"]')!;
    expect(cls(pin)).toEqual(expect.arrayContaining(['hidden', 'lg:block', 'xl:hidden']));
  });

  it('the panel showing the needs-you task holds off the global banner for it', async () => {
    const { hiddenNeedsInputSnapshot } = await import('@/lib/needs-input-hidden');
    await render({ pulse: needs }, { views });
    expect(hiddenNeedsInputSnapshot().has(NEED_TASK)).toBe(true);
    await act(async () => { (q('[data-testid="dock-close"]') as HTMLButtonElement).click(); });
    expect(hiddenNeedsInputSnapshot().has(NEED_TASK)).toBe(false);
  });

  it('closed stays closed for the session, for that task', async () => {
    await render({ pulse: needs }, { views });
    await act(async () => { (q('[data-testid="dock-close"]') as HTMLButtonElement).click(); });
    expect(q('[data-testid="chat-dock"]')).toBeNull();
    fresh();
    await render({ pulse: needs }, { views });
    expect(q('[data-testid="chat-dock"]')).toBeNull();
    window.sessionStorage.clear();
    fresh();
    await render({ pulse: needs }, { views });
    expect(q('[data-testid="chat-dock"]')?.dataset.mode).toBe('needs');
  });

  it('Ask about it says it in the chat; Answer it opens the question in the panel', async () => {
    await render({ pulse: needs }, { views });
    const [answer, ask] = qa('[data-testid="dock-action"]');
    await act(async () => { ask.click(); });
    expect(sent.at(-1)).toContain('totals in the buyer currency');
    await act(async () => { answer.click(); });
    const dock = q('[data-testid="chat-dock"]')!;
    expect(dock.dataset.mode).toBe('object');
    expect(dock.dataset.ref).toBe('question:w-need');
  });

  it('HISTORY toggles the conversation list in the panel', async () => {
    await render({ pulse: needs, aside: <nav data-testid="history-list" /> }, { views });
    await act(async () => { (q('[data-testid="chat-history-toggle"]') as HTMLButtonElement).click(); });
    const dock = q('[data-testid="chat-dock"]')!;
    expect(dock.dataset.mode).toBe('history');
    expect(cls(dock)).toContain('lg:flex');
    expect(dock.querySelector('[data-testid="history-list"]')).not.toBeNull();
    await act(async () => { (q('[data-testid="chat-history-toggle"]') as HTMLButtonElement).click(); });
    expect(q('[data-testid="chat-dock"]')?.dataset.mode).toBe('needs');
  });

  it('the summoned overlay has no dock', async () => {
    await render({ variant: 'overlay', onClose() {}, pulse: needs }, { views });
    expect(q('[data-testid="chat-dock"]')).toBeNull();
  });
});

// A tablet (768 to 1023) used to get its own chat: agent / workspace crumbs,
// a rounded bubble and a 540px chat beside a side-by-side pane. It now gets
// the phone's v3 single column; only 1024px and up docks.
describe('tablet (800px): the phone v3 layout, not the old split', () => {
  /** matchMedia answered for a viewport `width` px wide (min/max-width only). */
  const viewport = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    (window as any).matchMedia = (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      const matches = (min || max) ? (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) : false;
      return { matches, media: query, addEventListener() {}, removeEventListener() {} };
    };
  };
  const tokens = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
  const sheet = () => document.querySelector('[data-testid="chat-object-sheet"]');

  it('renders the kit thread in one column, with no tablet-only chrome', async () => {
    viewport(800);
    await render({ title: 'Gift card retries', messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    // The v3 thread: the kit's ChatThread with buildd's frames.
    const thread = q('.kit-thread.buildd-thread');
    expect(thread).not.toBeNull();
    expect(qa('.buildd-thread .kit-msg').length).toBeGreaterThan(0);
    expect(q('[data-testid="feed-user-bubble"]')).not.toBeNull();
    // One column: no side-by-side pane, no divider, no 540px chat.
    expect(q('[data-testid="chat-pane"]')).toBeNull();
    expect(q('[data-testid="chat-workspace"]')?.children).toHaveLength(1);
    // Nothing on the surface switches at 768px: the phone look holds to 1024px.
    for (const id of ['chat-workspace', 'chat-column', 'chat-header', 'canvas-crumbs', 'chat-title', 'chat-voice-column', 'chat-composer-column', 'chat-sea', 'feed-user-bubble']) {
      const el = q(`[data-testid="${id}"]`);
      expect(el).not.toBeNull();
      expect(tokens(el).filter(c => /^(max-)?md:/.test(c))).toEqual([]);
    }
    expect(tokens(q('[data-testid="chat-composer-column"]')!.parentElement).filter(c => /^(max-)?md:/.test(c))).toEqual([]);
    // The phone header: CHAT / <title>, HISTORY → (a link, hidden only from lg).
    expect(q('[data-testid="chat-mobile-section"]')?.textContent).toBe('Chat');
    expect(tokens(q('[data-testid="chat-history-link"]'))).toContain('lg:hidden');
    expect(q('[data-testid="canvas-crumbs-desktop"]')).toBeNull();
    expect(q('[data-testid="chat-new"]')).toBeNull();
  });

  it('an object opens as a sheet at 800px, and docks at 1280px', async () => {
    viewport(800);
    await render({ focusRef: fixtures.missionRef });
    expect(sheet()).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    viewport(1280);
    await render({ focusRef: fixtures.missionRef });
    expect(sheet()).toBeNull();
    expect(q('[data-testid="chat-dock"]')?.dataset.mode).toBe('object');
  });

  it('the stylesheet has no chat rule scoped to the 768 to 1023 band', () => {
    expect(GLOBALS).not.toContain('(min-width: 768px) and (max-width: 1023px)');
    const chatCss = GLOBALS.slice(GLOBALS.indexOf('/* ── The empty canvas (ChatWorkspace)'), GLOBALS.indexOf('/* ── Steer on the kit'));
    expect(chatCss).not.toContain('@media (min-width: 768px)');
    expect(chatCss).not.toContain('@media (max-width: 767px)');
  });
});
