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

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/chat',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatWorkspace } = await import('./ChatWorkspace');
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

async function render(over: Partial<Props> = {}, opts: { hints?: boolean; state?: Parameters<typeof fixtures.fixtureViews>[0]; views?: Record<string, unknown> } = {}) {
  const views: Record<string, unknown> = { ...fixtures.fixtureViews(opts.state ?? 'split'), ...opts.views };
  const source = { load: async (r: { kind: string; id: string }) => { const v = views[`${r.kind}:${r.id}`]; if (!v) throw new Error('Not found'); return v; } };
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
    expect(q('[data-testid="composer-stop"]')).not.toBeNull();
    expect(q('[data-testid="composer-send"]')).toBeNull();
  });

  it('the streaming turn is the Thinking panel: plain steps, no tool names, one active step', async () => {
    await render({ messages: msgs(), status: 'streaming' });
    const panel = q('[data-testid="thinking-panel"]');
    expect(panel).not.toBeNull();
    const steps = qa('[data-testid="thinking-step"]');
    expect(steps.map(s => s.dataset.state)).toEqual(['done', 'active']);
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
    const stop = q('[data-testid="composer-stop"]') as HTMLButtonElement | null;
    expect(stop).not.toBeNull();
    expect(stop!.disabled).toBe(true);
    expect(q('[data-testid="composer-send"]')).toBeNull();
    expect(q('[data-testid="composer-sweep"]')).not.toBeNull();
  });

  it('once the turn lands it reads as the normal feed again', async () => {
    await render({ messages: msgs(), status: 'ready' });
    expect(q('[data-testid="thinking-panel"]')).toBeNull();
    expect(q('[data-testid="tool-call-row"]')).not.toBeNull();
  });

  it('submitted, nothing streamed: the panel says it is reading the question', async () => {
    await render({ messages: msgs().slice(0, 1), status: 'submitted' });
    expect(qa('[data-testid="thinking-step"]').map(s => s.textContent)).toEqual(['Reading your question']);
  });
});

describe('phone layout: hero on top, open sea, PICKED FOR YOU right above the composer', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
  for (const pulse of [{ needsYou: [], live: 0 }, { needsYou: [{ title: 'Pick a currency' }], live: 0 }]) {
    it(`${pulse.needsYou.length ? 'needs-you' : 'calm'}: the panel is the last thing in a full-height column, after a growing gap`, async () => {
      await render({ pulse });
      const canvas = q('[data-testid="canvas-empty"]')!;
      expect(canvas.dataset.layout).toBe('anchored');
      expect(cls(canvas)).toEqual(expect.arrayContaining(['max-md:flex', 'max-md:flex-1', 'max-md:flex-col']));
      const gap = q('[data-testid="canvas-sea-gap"]')!;
      expect(cls(gap)).toContain('max-md:flex-1');
      expect(gap.nextElementSibling?.getAttribute('data-testid')).toBe('canvas-suggestions');
      expect(q('[data-testid="canvas-suggestions"]')?.nextElementSibling).toBeNull();
      expect(cls(canvas.parentElement)).toEqual(expect.arrayContaining(['max-md:flex', 'max-md:min-h-full', 'max-md:flex-col']));
    });
  }

  it('a scoped chat and a thread keep the flowing layout', async () => {
    await render({ entryIntent: 'mission' });
    expect(q('[data-testid="canvas-empty"]')?.dataset.layout).toBeUndefined();
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    expect(cls(q('[data-testid="chat-feed"]')?.parentElement ?? null)).not.toContain('max-md:min-h-full');
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
    const send = q('[data-testid="composer-send"]')!;
    expect(send.getAttribute('aria-disabled')).toBe('true');
    expect(cls(send).filter(c => /opacity|brightness/.test(c) && !c.includes('hover:'))).toEqual([]);
    expect(cls(send)).toContain('bg-[var(--mood-needs-fill)]');
    expect(cls(send)).toContain('text-[var(--on-mood-needs)]');
  });

  it('an empty send does nothing', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    await act(async () => { q('[data-testid="composer-send"]')!.click(); });
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
    const form = cls(q('[data-testid="chat-composer"] form'));
    expect(form).toContain('border-t-[var(--chat-rule-strong)]');
    expect(form.filter(c => c.startsWith('focus-within:border-t'))).toEqual([]);
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
  const labels = () => qa('[data-testid="canvas-suggestion-label"]').map(c => c.textContent);
  const placeholder = () => (q('#chat-composer-input') as HTMLTextAreaElement).placeholder;

  it('without a pulse: greets by name, claims no mood, and offers no needs-you prompt', async () => {
    await render();
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Hi Maya, what are we working on?');
    expect(q('[data-testid="canvas-mood-dot"]')).toBeNull();
    expect(labels()).toEqual(["What's running right now?", 'Start something new']);
    await act(async () => { qa('[data-testid="canvas-suggestion"]')[0].click(); });
    expect(sent).toEqual(["What's running right now?"]);
  });

  it('calm: all quiet, exactly two picked rows, nothing copper, the top row is the placeholder', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('calm');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('All quiet.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('nothing blocked');
    expect(qa('[data-testid="canvas-suggestion"]')).toHaveLength(2);
    expect(qa('[data-testid="canvas-suggestion"][data-tone="needs"]')).toHaveLength(0);
    expect(placeholder()).toBe('Start something new…');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('calm');
  });

  it('needs you: names it, row 1 is copper, the composer rule turns copper', async () => {
    await render({ pulse: { needsYou: [{ title: 'Pick a currency' }], live: 1 } });
    expect(q('[data-testid="canvas-empty"]')?.dataset.mood).toBe('needs');
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('One thing needs you.');
    expect(q('[data-testid="canvas-picked-status"]')?.textContent).toBe('1 blocked');
    const rows = qa('[data-testid="canvas-suggestion"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].dataset.tone).toBe('needs');
    expect(placeholder()).toBe('Answer the waiting question');
    expect(q('[data-testid="chat-composer"]')?.dataset.mood).toBe('needs');
    await act(async () => { rows[0].click(); });
    expect(sent).toEqual(['What does "Pick a currency" need from me?']);
  });

  it('a starter fills the box instead of sending', async () => {
    await render({ pulse: { needsYou: [], live: 0 } });
    const starter = qa('[data-testid="canvas-suggestion"]').find(c => c.textContent?.includes('Start something new'))!;
    await act(async () => { starter.click(); });
    expect(sent).toEqual([]);
    expect((q('#chat-composer-input') as HTMLTextAreaElement).value).toBe('I want to build ');
  });
});

// happy-dom applies no media queries, so the phone-only rules are asserted as
// the breakpoint classes that carry them (md = 768px, desktop unchanged).
describe('phone chrome (v3 frames)', () => {
  const header = () => q('[data-testid="chat-header"]')!;

  it('a new chat: `CHAT / new` left, `HISTORY →` right, no back arrow on a phone', async () => {
    await render();
    const section = q('[data-testid="chat-mobile-section"]')!;
    expect(section.textContent).toBe('Chat');
    expect(section.className).toMatch(/(^|\s)md:hidden(\s|$)/);
    expect(section.className).toMatch(/uppercase/);
    expect(q('[data-testid="chat-title-mobile"]')?.textContent).toBe('new');
    expect(q('[data-testid="chat-title-mobile"]')?.className).toMatch(/(^|\s)md:hidden(\s|$)/);
    const history = q('[data-testid="chat-history-link"]') as HTMLAnchorElement;
    expect(history.getAttribute('href')).toBe('/app/chat?view=history');
    expect(history.textContent).toBe('History →');
    expect(history.className).toMatch(/(^|\s)md:hidden(\s|$)/);
    expect(header().querySelector('a[aria-label="All chats"]')).toBeNull();
    // Desktop keeps its title and + New chat.
    expect(q('[data-testid="chat-title"]')?.textContent).toContain('New chat');
    expect(q('[data-testid="chat-new"]')).not.toBeNull();
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
    expect(q('[data-testid="canvas-empty"]')?.className).toMatch(/max-md:hidden/);
  });

  it('the new-chat canvas hides "Pick up where you left off" on a phone, keeps it on desktop', async () => {
    await render({ emptyState: <nav data-testid="conversation-list" /> });
    const wrap = q('[data-testid="chat-empty-state"]')!;
    expect(wrap.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(wrap.className).toMatch(/md:block/);
    expect(wrap.querySelector('[data-testid="conversation-list"]')).not.toBeNull();
    expect(q('[data-testid="canvas-empty"]')?.className).not.toMatch(/max-md:hidden/);
  });

  it('the form fallback is desktop only', async () => {
    await render({ formFallbackHref: '/app/missions/new' });
    const fallback = q('[data-testid="chat-form-fallback"]')!;
    expect(fallback.parentElement!.className).toMatch(/(^|\s)hidden(\s|$)/);
    expect(fallback.parentElement!.className).toMatch(/md:flex/);
  });

  it('the scope cell reads `@ all ▾` on a phone when every workspace is in scope', async () => {
    await render({ workspaceId: null });
    const chip = q('[data-testid="composer-scope-chip"]')!;
    const short = chip.querySelector('[data-testid="scope-chip-short"]')!;
    expect(short.textContent).toBe('all');
    expect(short.className).toMatch(/(^|\s)md:hidden(\s|$)/);
    const long = chip.querySelector('[data-testid="scope-chip-name"]')!;
    expect(long.textContent).toBe('All workspaces');
    expect(long.className).toMatch(/max-md:hidden/);
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
    const pin = q('[data-testid="canvas-pinned"]');
    expect(pin?.dataset.kind).toBe('mission');
    expect(qa('[data-testid="canvas-mini-row"]').length).toBeGreaterThan(0);
    expect(q('[data-testid="canvas-empty"]')?.textContent).toContain('Ask anything about');
  });

  it('no object in the conversation: nothing pinned', async () => {
    await render();
    expect(q('[data-testid="canvas-pinned"]')).toBeNull();
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
    expect(q('[data-testid="canvas-pinned"]')).toBeNull();
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
    expect(q('[data-testid="mission-context-insight"]')?.textContent).toContain('waiting on you');
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
    expect(cell?.textContent).toBe(`mission · ${fixtures.WS.name}`);
    expect(q('[data-testid="composer-scope-lock"]')).not.toBeNull();
    expect(q('[data-testid="composer-scope-chip"]')).toBeNull();
  });

  it('after the first message the card gives way to the pinned strip', async () => {
    await render(overlay({ messages: fixtures.chatFixture('streaming').messages, status: 'ready' }));
    expect(q('[data-testid="mission-context-card"]')).toBeNull();
    expect(q('[data-testid="canvas-pinned"]')).not.toBeNull();
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
});

describe('desktop (>= 1024px): one 720px voice column over the sea (docs/design/chat-v3-desktop.md)', () => {
  const cls = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/);
  const calm = { needsYou: [], live: 0 };

  it('the sea fills the stage on desktop too, over the chat ground', async () => {
    await render({ pulse: calm });
    const layer = cls(q('[data-testid="chat-sea"]'));
    expect(layer).toContain('md:hidden');
    expect(layer).toContain('lg:block');
    expect(cls(q('[data-testid="chat-column"]'))).toContain('lg:bg-[var(--chat-ground)]');
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
    expect(cls(canvas)).toEqual(expect.arrayContaining(['lg:flex', 'lg:flex-1', 'lg:flex-col', 'lg:mb-0']));
    expect(cls(canvas.parentElement)).toEqual(expect.arrayContaining(['lg:flex', 'lg:min-h-full', 'lg:flex-col']));
    expect(cls(q('[data-testid="canvas-sea-gap"]'))).toContain('lg:flex-1');
    expect(cls(q('[data-testid="canvas-suggestions"]'))).toContain('lg:mt-0');
  });

  it('header: `CHAT / new` left and `HISTORY →` right, over the opaque bar; no agent crumbs, no + New chat', async () => {
    await render({ pulse: calm });
    expect(cls(q('[data-testid="chat-header"]'))).toContain('lg:bg-[var(--chat-bar)]');
    expect(cls(q('[data-testid="chat-mobile-section"]'))).toContain('lg:inline');
    expect(cls(q('[data-testid="chat-title-mobile"]'))).toContain('lg:inline');
    expect(cls(q('[data-testid="canvas-crumbs-desktop"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="chat-title-desktop"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="chat-history-link"]'))).toContain('lg:inline-flex');
    expect(cls(q('[data-testid="chat-new"]'))).toContain('lg:hidden');
  });

  it('an open conversation reads `CHAT / <title>` in the phone style', async () => {
    await render({ title: 'Gift card retries', messages: fixtures.chatFixture('streaming').messages });
    const title = cls(q('[data-testid="chat-title"]'));
    expect(title).toEqual(expect.arrayContaining(['lg:font-normal', 'lg:text-[var(--chat-muted)]']));
  });

  it('the calm canvas shows neither the RECENT list nor the form link; the history view shows the list', async () => {
    await render({ pulse: calm, formFallbackHref: '/app/missions/new', emptyState: <nav data-testid="conversation-list" /> });
    expect(cls(q('[data-testid="chat-empty-state"]'))).toContain('lg:hidden');
    expect(cls(q('[data-testid="chat-form-fallback"]')!.parentElement)).toContain('lg:hidden');
    await render({ historyOpen: true, emptyState: <nav data-testid="conversation-list" /> });
    expect(cls(q('[data-testid="chat-empty-state"]'))).not.toContain('lg:hidden');
    expect(cls(q('[data-testid="canvas-empty"]'))).toContain('lg:hidden');
  });

  it('the composer holds its edge over the sea: 1px border, 4px offset shadow, cells 64 / 88 / 64', async () => {
    await render({ pulse: calm, workspaceId: null, teamId: 'team-1' });
    const form = cls(q('[data-testid="chat-composer"] form'));
    expect(form).toEqual(expect.arrayContaining(['md:border-x', 'md:border-b', 'lg:shadow-[4px_4px_0_0_var(--chat-rule)]']));
    expect(cls(q('[data-testid="composer-send"]'))).toContain('lg:w-16');
    expect(cls(q('[data-testid="composer-tools-cell"]'))).toContain('lg:w-16');
    // The scope cell reads `@ all` as on the frame.
    expect(cls(q('[data-testid="scope-chip-short"]'))).toContain('lg:inline');
    expect(cls(q('[data-testid="scope-chip-name"]'))).toContain('lg:hidden');
  });

  it('the person\'s message is the square phone bubble, not the rounded one', async () => {
    await render({ messages: fixtures.chatFixture('streaming').messages, status: 'streaming' });
    const bubble = cls(q('[data-testid="feed-user-bubble"]'));
    expect(bubble).toEqual(expect.arrayContaining(['lg:rounded-none', 'lg:border', 'lg:bg-[var(--chat-raised)]', 'lg:[font-family:var(--font-newsreader),ui-serif,Georgia,serif]']));
  });

  it('the context aside is gone on the empty canvas (PICKED FOR YOU replaces it); a thread keeps its side slot', async () => {
    await render({ pulse: calm, aside: <div data-testid="old-aside" /> });
    expect(q('[data-testid="chat-aside"]')).toBeNull();
    // A fresh mount: the pane's closed state is read once, at mount.
    act(() => root.unmount());
    root = createRoot(container);
    await render({ messages: fixtures.chatFixture('confirmed').messages, initialPaneClosed: true, aside: <div data-testid="old-aside" /> });
    expect(q('[data-testid="chat-aside"]')).not.toBeNull();
    // The column centres in whatever the side slot leaves: it is the stage's flex-1.
    expect(cls(q('[data-testid="chat-column"]'))).toContain('flex-1');
  });
});