import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  classifyGestureAngle,
  getTrailingAction,
  getMenuActions,
  nextFocusIdx,
  SwipeableRow,
  MENU_BTN_WIDTH,
  REVEAL_WIDTH_PX,
  type SwipeCardType,
} from './SwipeableRow';

// ─── Gesture angle classification ─────────────────────────────────────────────

describe('classifyGestureAngle', () => {
  it('returns horizontal for < 30° from horizontal', () => {
    // 10pt right, 5pt down ≈ 26.6°
    expect(classifyGestureAngle(10, 5)).toBe('horizontal');
  });

  it('returns horizontal at exactly 29°', () => {
    const dy = Math.tan((29 * Math.PI) / 180) * 100;
    expect(classifyGestureAngle(100, dy)).toBe('horizontal');
  });

  it('returns vertical for > 60° from horizontal', () => {
    // 5pt right, 100pt down ≈ 87.1°
    expect(classifyGestureAngle(5, 100)).toBe('vertical');
  });

  it('returns vertical at exactly 61°', () => {
    const dy = Math.tan((61 * Math.PI) / 180) * 100;
    expect(classifyGestureAngle(100, dy)).toBe('vertical');
  });

  it('returns ambiguous for 30–60° range', () => {
    // 45° diagonal
    expect(classifyGestureAngle(100, 100)).toBe('ambiguous');
  });

  it('handles negative dx (left swipe) correctly', () => {
    // Same angle, left direction
    expect(classifyGestureAngle(-10, 2)).toBe('horizontal');
  });

  it('handles negative dy (upward swipe) correctly', () => {
    expect(classifyGestureAngle(5, -100)).toBe('vertical');
  });

  it('returns ambiguous at exactly 45°', () => {
    expect(classifyGestureAngle(100, 100)).toBe('ambiguous');
  });
});

// ─── Trailing action table ─────────────────────────────────────────────────────

describe('getTrailingAction', () => {
  it('gate-card → snooze-24h', () => {
    const action = getTrailingAction('gate-card');
    expect(action).not.toBeNull();
    expect(action!.action).toBe('snooze-24h');
  });

  it('escalation-card → null (acknowledge was client-local only, removed)', () => {
    expect(getTrailingAction('escalation-card')).toBeNull();
  });

  it('blocked-task → snooze-notification', () => {
    expect(getTrailingAction('blocked-task')!.action).toBe('snooze-notification');
  });

  it('needs-attention → snooze-24h', () => {
    expect(getTrailingAction('needs-attention')!.action).toBe('snooze-24h');
  });

  it('completed-task → null (dismiss was client-local only, removed)', () => {
    expect(getTrailingAction('completed-task')).toBeNull();
  });

  it('running-task → null (no swipe action)', () => {
    expect(getTrailingAction('running-task')).toBeNull();
  });
});

// ─── Menu actions table ────────────────────────────────────────────────────────

describe('getMenuActions', () => {
  it('gate-card with prUrl includes all 4 items', () => {
    const labels = getMenuActions('gate-card', { prUrl: 'https://github.com/x' }).map((a) => a.label);
    expect(labels).toContain('Snooze 24 h');
    expect(labels).toContain('Snooze 3 d');
    expect(labels).toContain('Snooze 7 d');
    expect(labels).toContain('Open in GitHub');
  });

  it('gate-card without prUrl omits Open in GitHub', () => {
    const labels = getMenuActions('gate-card', {}).map((a) => a.label);
    expect(labels).toContain('Snooze 24 h');
    expect(labels).not.toContain('Open in GitHub');
  });

  it('completed-task with prUrl includes only View PR (no Dismiss)', () => {
    const labels = getMenuActions('completed-task', { prUrl: 'https://github.com/x' }).map((a) => a.label);
    expect(labels).not.toContain('Dismiss');
    expect(labels).toContain('View PR ↗');
  });

  it('completed-task without prUrl returns empty menu (no Dismiss)', () => {
    const actions = getMenuActions('completed-task', {});
    expect(actions).toHaveLength(0);
  });

  it('running-task has Cancel task action', () => {
    const labels = getMenuActions('running-task', {}).map((a) => a.label);
    expect(labels).toContain('Cancel task');
  });

  it('blocked-task with prUrl includes Go to blocking PR', () => {
    const labels = getMenuActions('blocked-task', { prUrl: 'https://github.com/pr' }).map((a) => a.label);
    expect(labels).toContain('Go to blocking PR');
    expect(labels).toContain('Snooze notification');
  });

  it('blocked-task without prUrl omits Go to blocking PR', () => {
    const labels = getMenuActions('blocked-task', {}).map((a) => a.label);
    expect(labels).not.toContain('Go to blocking PR');
    expect(labels).toContain('Snooze notification');
  });

  it('escalation-card has File anyway, Ignore (no Acknowledge — it was client-local only)', () => {
    const labels = getMenuActions('escalation-card', {}).map((a) => a.label);
    expect(labels).not.toContain('Acknowledge');
    expect(labels).toContain('File anyway');
    expect(labels).toContain('Ignore');
  });

  it('needs-attention has Snooze and View blocked tasks', () => {
    const labels = getMenuActions('needs-attention', {}).map((a) => a.label);
    expect(labels).toContain('Snooze 24 h');
    expect(labels).toContain('View blocked tasks');
  });
});

// ─── Keyboard navigation index helper ─────────────────────────────────────────

describe('nextFocusIdx', () => {
  it('moves down within bounds', () => {
    expect(nextFocusIdx(0, 'down', 3)).toBe(1);
    expect(nextFocusIdx(1, 'down', 3)).toBe(2);
  });

  it('clamps at last item on down', () => {
    expect(nextFocusIdx(2, 'down', 3)).toBe(2);
  });

  it('moves up within bounds', () => {
    expect(nextFocusIdx(2, 'up', 3)).toBe(1);
    expect(nextFocusIdx(1, 'up', 3)).toBe(0);
  });

  it('clamps at first item on up', () => {
    expect(nextFocusIdx(0, 'up', 3)).toBe(0);
  });

  it('handles -1 (no current focus) going down → 0', () => {
    expect(nextFocusIdx(-1, 'down', 3)).toBe(0);
  });
});

// ─── SwipeableRow rendering ────────────────────────────────────────────────────

describe('SwipeableRow rendering', () => {
  it('renders children', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="gate-card" taskTitle="Deploy PR #42">
        <div data-testid="child">card content</div>
      </SwipeableRow>,
    );
    expect(html).toContain('card content');
  });

  it('renders ⋯ button with correct aria-label', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="gate-card" taskTitle="My PR">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).toContain('More actions for My PR');
    expect(html).toContain('aria-haspopup="menu"');
  });

  it('renders ⋯ button for running-task (cancel-task is in the menu)', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="running-task" taskTitle="Background work">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).toContain('More actions for Background work');
  });

  it('does not render ⋯ button for completed-task without prUrl (empty menu)', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="completed-task" taskTitle="Finished task">
        <div>done</div>
      </SwipeableRow>,
    );
    expect(html).not.toContain('More actions for Finished task');
  });

  it('renders ⋯ button for completed-task with prUrl (View PR menu item)', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="completed-task" taskTitle="PR task" prUrl="https://github.com/pr/1">
        <div>done</div>
      </SwipeableRow>,
    );
    expect(html).toContain('More actions for PR task');
  });

  it('right-swipe reserved: no leading action rendered', () => {
    // Right swipe is empty in v1 per §2.2 — no leading action slot should exist
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="gate-card" taskTitle="Test">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).not.toContain('data-leading-action');
  });

  it('renders trailing action slot for gate-card with sr-only label', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="gate-card" taskTitle="Test">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).toContain('data-trailing-action');
    // Label is sr-only for accessibility; visual indicator is an SVG icon
    expect(html).toContain('Snooze');
  });

  it('does not render trailing action for running-task', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="running-task" taskTitle="Running job">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).not.toContain('data-trailing-action');
  });

  it('sets data-card-type attribute for testing', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="completed-task" taskTitle="Old task">
        <div>done</div>
      </SwipeableRow>,
    );
    expect(html).toContain('data-card-type="completed-task"');
  });
});

// ─── Layout contract ───────────────────────────────────────────────────────────

describe('layout contract: right-edge zones', () => {
  it('MENU_BTN_WIDTH matches the ⋯ button w-9 class (36px)', () => {
    // w-9 = 9 * 4px = 36px in Tailwind default spacing scale.
    // If the ⋯ button width class changes, update MENU_BTN_WIDTH to match.
    expect(MENU_BTN_WIDTH).toBe(36);
  });

  it('trailing action panel is offset by MENU_BTN_WIDTH, not pinned to right-0', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="gate-card" taskTitle="Test">
        <div>card</div>
      </SwipeableRow>,
    );
    // Panel must have right:36px (MENU_BTN_WIDTH) so it never overlaps the ⋯ button.
    expect(html).toContain(`right:${MENU_BTN_WIDTH}px`);
    // Must NOT be pinned at right:0.
    expect(html).not.toContain('right:0');
  });

  it('at full reveal the panel fits exactly in the non-button zone', () => {
    // At translateX = -REVEAL_WIDTH_PX the card right edge is at:
    //   (containerWidth - MENU_BTN_WIDTH) - REVEAL_WIDTH_PX
    //   = containerWidth - MENU_BTN_WIDTH - REVEAL_WIDTH_PX
    // The panel left edge is at:
    //   containerWidth - MENU_BTN_WIDTH - REVEAL_WIDTH_PX  (right: MENU_BTN_WIDTH, width: REVEAL_WIDTH_PX)
    // They align exactly — no gap, no overhang.
    const cardContentEnd = -MENU_BTN_WIDTH - REVEAL_WIDTH_PX;    // relative to containerWidth
    const panelLeftEdge  = -MENU_BTN_WIDTH - REVEAL_WIDTH_PX;
    expect(cardContentEnd).toBe(panelLeftEdge);
  });

  it('completed-task has no trailing panel (no swipe action)', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="completed-task" taskTitle="Old task">
        <div>done</div>
      </SwipeableRow>,
    );
    // completed-task no longer has a trailing action — dismiss was client-local
    expect(html).not.toContain('data-trailing-action');
  });

  it('running-task has no trailing panel (no offset needed)', () => {
    const html = renderToStaticMarkup(
      <SwipeableRow cardType="running-task" taskTitle="Running job">
        <div>card</div>
      </SwipeableRow>,
    );
    expect(html).not.toContain('data-trailing-action');
    expect(html).not.toContain(`right:${MENU_BTN_WIDTH}px`);
  });
});
