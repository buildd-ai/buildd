/**
 * Visual review in the chat, mounted (happy-dom) through ChatWorkspace: the
 * mission card's Screens row, "Review N" opening the deck inline in the pane
 * (desktop) or the sheet (phone, never a Dialog inside the BottomSheet), a
 * decision going straight to ChatActions.reviewShots with the store moving
 * optimistically, and the pinned strip's chip. Illustrative fixtures only.
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/chat' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { VisualReviewDecisionResponse } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => '/app/chat',
  useSearchParams: () => new URLSearchParams(),
}));

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ChatWorkspace } = await import('../ChatWorkspace');
const { ObjectStoreProvider } = await import('./ObjectStoreProvider');
const { createObjectStore } = await import('./object-store');
const fixtures = await import('../../../app/app/dev/chat/chat-fixtures');
const { createFixtureVisualReviewTransport } = await import('@/components/visual-review/fixture-transport');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;
let desktop = true;

beforeEach(() => {
  (window as any).matchMedia = (q: string) => ({ matches: q.includes('min-width') ? desktop : false, addEventListener() {}, removeEventListener() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

type Props = Parameters<typeof ChatWorkspace>[0];

async function render(over: Partial<Props> = {}) {
  const views = fixtures.fixtureViews('visual');
  const transport = createFixtureVisualReviewTransport(fixtures.VISUAL_FIXTURE_PHASE, fixtures.VISUAL_FIXTURE_OPTS);
  const store = createObjectStore({
    load: async (r) => {
      const v = views[`${r.kind}:${r.id}`];
      if (!v) throw new Error('Not found');
      return v.kind === 'mission' ? { ...v, visual: transport.model() } : v;
    },
  });
  const reviewShots = mock(async ({ missionId: _m, ...req }: Parameters<NonNullable<Props['reviewShots']>>[0]): Promise<VisualReviewDecisionResponse> => transport.decide(req));
  const undoReview = mock(async ({ reviewId }: { missionId: string; reviewId: string }) => transport.undo(reviewId));
  const props: Props = {
    messages: fixtures.chatFixture('visual').messages, status: 'ready', onSend() {}, onApproval() {},
    title: null, agent: fixtures.ORGANIZER, tier: 'standard', workspaces: fixtures.WORKSPACES,
    workspaceId: fixtures.WS.id, onWorkspaceChange() {}, viewerName: 'Maya',
    reviewShots, undoReview, initialPaneClosed: true, ...over,
  };
  await act(async () => {
    root.render(
      <ObjectStoreProvider store={store}>
        <ChatWorkspace {...props} />
      </ObjectStoreProvider>,
    );
  });
  await flush();
  return { store, reviewShots, undoReview, transport };
}

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const qa = (sel: string) => [...document.querySelectorAll(sel)] as HTMLElement[];
const click = async (el: HTMLElement | null) => { expect(el).not.toBeNull(); await act(async () => { el!.click(); }); await flush(); };

describe('the mission card in the thread', () => {
  it('shows the Screens line, the counts and "Review N"', async () => {
    await render();
    const row = q('[data-testid="mission-card-visual"]');
    expect(row).not.toBeNull();
    expect(row!.querySelector('[data-testid="visual-review-line"]')).not.toBeNull();
    expect(row!.querySelector('[data-testid="mission-card-visual-counts"]')!.textContent).toMatch(/\d+ ok, \d+ issues?/);
    expect(q('[data-testid="mission-card-review"]')!.textContent).toBe('Review 1');
  });

  it('the visual_review events render as toned rows with their counts', async () => {
    await render();
    const rows = qa('[data-testid="feed-event"][data-event="visual_review"]');
    expect(rows.length).toBe(3);
    expect(rows[0].dataset.tone).toBe('blocked');
    expect(rows[0].textContent).toMatch(/no browser runner online \(0 screens captured\)/);
    expect(rows[1].textContent).toMatch(/^Round \d done: \d+ ok/);
  });
});

describe('review on desktop: the deck takes the pane', () => {
  it('Review opens the deck inline in the pane, and a decision goes to reviewShots directly', async () => {
    desktop = true;
    const { reviewShots, store } = await render();
    await click(qa('[data-testid="mission-card-review"]')[0]);
    // Pane, dock and sheet can all be mounted at once (CSS hides two): exactly
    // one deck, so a key or a swipe decides once.
    expect(qa('[data-testid="visual-review-deck"]')).toHaveLength(1);
    const deck = q('[data-testid="visual-review-deck"]');
    expect(deck!.dataset.layout).toBe('sheet');
    expect(q('[data-testid="chat-dock"]')!.contains(deck)).toBe(true);
    expect(q('[data-testid="chat-dock"]')!.dataset.wide).toBe('true');
    expect(q('[role="dialog"] [data-testid="visual-review-deck"]')).toBeNull();
    expect(q('[data-testid="chat-object-sheet"]')).toBeNull();

    const before = (store.get(fixtures.missionRef).view as any).visual.summary.awaitingHuman;
    expect(before).toBe(1);
    await click(q('[data-testid="deck-looks-right"]'));
    expect(reviewShots).toHaveBeenCalledTimes(1);
    const arg = reviewShots.mock.calls[0][0];
    expect(arg.missionId).toBe(fixtures.MISSION_ID);
    expect(arg.decision).toBe('looks_right');
    expect(arg.artifactIds.length).toBeGreaterThan(0);
    for (const id of arg.artifactIds) expect(arg.expected[id]).toBeDefined();
    // The store moved: the card and the strip read it.
    expect((store.get(fixtures.missionRef).view as any).visual.summary.awaitingHuman).toBe(0);
    expect(q('[data-testid="deck-toast"]')).not.toBeNull();

    await click(q('[data-testid="deck-close"]'));
    expect(q('[data-testid="visual-review-deck"]')).toBeNull();
  });

  it('a key decides once, whatever else is mounted', async () => {
    desktop = true;
    const { reviewShots } = await render();
    await click(qa('[data-testid="mission-card-review"]')[0]);
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', bubbles: true })); });
    await flush();
    expect(reviewShots).toHaveBeenCalledTimes(1);
  });

  it('Undo from the toast calls undoReview', async () => {
    desktop = true;
    const { undoReview } = await render();
    await click(qa('[data-testid="mission-card-review"]')[0]);
    await click(q('[data-testid="deck-looks-right"]'));
    await click(q('[data-testid="deck-undo"]'));
    expect(undoReview).toHaveBeenCalledTimes(1);
  });
});

describe('review on a phone: the deck takes the sheet', () => {
  it('opens inside the BottomSheet, inline (no Dialog stacked in it), full bleed', async () => {
    desktop = false;
    await render();
    await click(qa('[data-testid="mission-card-review"]')[0]);
    const sheet = q('[data-testid="chat-object-sheet"]');
    expect(sheet).not.toBeNull();
    expect(qa('[data-testid="visual-review-deck"]')).toHaveLength(1);
    // The sheet's own close ends the review: no second close inside it.
    expect(sheet!.querySelector('[data-testid="deck-close"]')).toBeNull();
    const deck = sheet!.querySelector('[data-testid="visual-review-deck"]') as HTMLElement | null;
    expect(deck).not.toBeNull();
    expect(deck!.dataset.layout).toBe('sheet');
    expect(qa('[role="dialog"]').filter(d => d !== sheet && sheet!.contains(d))).toEqual([]);
    expect(sheet!.textContent).toContain('Review screens');
  });

  it('opens on arrival for the fixture deep link', async () => {
    desktop = false;
    await render({ initialVisualReview: { ref: fixtures.missionRef, startKey: null } });
    expect(q('[data-testid="chat-object-sheet"] [data-testid="visual-review-deck"]')).not.toBeNull();
  });
});

describe('the pinned strip', () => {
  it('shows the Line and the "N to review" chip, which opens the deck', async () => {
    desktop = false;
    await render({ focusRef: fixtures.missionRef, focusOpensSheet: false });
    const strip = q('[data-testid="canvas-pinned-visual"]');
    expect(strip).not.toBeNull();
    expect(strip!.querySelector('[data-testid="visual-review-line"]')).not.toBeNull();
    const chip = q('[data-testid="canvas-pinned-visual-chip"]');
    expect(chip!.textContent).toBe('1 to review');
    await click(chip);
    expect(q('[data-testid="chat-object-sheet"] [data-testid="visual-review-deck"]')).not.toBeNull();
  });
});
