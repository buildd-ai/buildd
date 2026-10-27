/**
 * DiagnosticsDisclosure, mounted (happy-dom): layer-3 diagnostics render for a
 * team admin or operator and never for a member, both on their own and inside
 * WaitingLine, the first adopter (the task page's waiting line).
 *
 * Runs in its own process (scripts/run-unit-tests.ts), so the DOM globals stay here.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/tasks/t1' });

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { WaitingReason } from '@buildd/core/waiting-reason';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: DiagnosticsDisclosure, DiagnosticsAudienceProvider } = await import('./DiagnosticsDisclosure');
const { default: WaitingLine } = await import('../tasks/WaitingLine');
const { canSeeDiagnostics } = await import('@/lib/diagnostics-audience');

let container: HTMLElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function openAll() {
  // Open every disclosure, outermost first, until none is left closed.
  for (let i = 0; i < 5; i++) {
    const closed = [...container.querySelectorAll('button[aria-expanded="false"]')] as HTMLButtonElement[];
    if (closed.length === 0) return;
    act(() => closed.forEach(b => b.click()));
  }
}

const REASON: WaitingReason = {
  kind: 'mission_concurrent',
  class: 'capacity',
  strength: 'hard',
  intent: 'intentional',
  blocker: { type: 'mission', id: 'm-1', label: 'mission limit', href: '/app/missions/m-1' },
  provenance: { source: 'ledger', derivedFrom: 'claim_loop_deferral', firstSeenAt: '2026-10-17T10:00:00Z' },
  because: 'the mission starts a task at most every 10 min',
  releasesWhen: { event: 'time', text: "the mission's pacing interval passes" },
  action: { owner: 'system', force: { scope: 'member', lifts: 'mission_concurrent', railsRemaining: [], mechanism: 'start_context' } },
} as WaitingReason;

describe('canSeeDiagnostics', () => {
  it('a team owner or admin sees diagnostics, a member does not', () => {
    expect(canSeeDiagnostics({ role: 'owner', operator: false })).toBe(true);
    expect(canSeeDiagnostics({ role: 'admin', operator: false })).toBe(true);
    expect(canSeeDiagnostics({ role: 'member', operator: false })).toBe(false);
    expect(canSeeDiagnostics({ role: null, operator: false })).toBe(false);
  });

  it('a platform operator sees diagnostics whatever their team role', () => {
    expect(canSeeDiagnostics({ role: 'member', operator: true })).toBe(true);
  });
});

describe('DiagnosticsDisclosure', () => {
  it('renders nothing without a provider: a surface that did not decide shows no diagnostics', () => {
    render(h(DiagnosticsDisclosure, null, 'gate: mission_held'));
    expect(container.textContent).toBe('');
  });

  it('renders nothing for a member', () => {
    render(h(DiagnosticsAudienceProvider, { visible: false }, h(DiagnosticsDisclosure, null, 'gate: mission_held')));
    expect(container.querySelector('[data-testid="diagnostics-disclosure"]')).toBeNull();
    expect(container.textContent).not.toContain('mission_held');
  });

  it('renders a closed Diagnostics disclosure for an admin or operator, with the detail inside', () => {
    render(h(DiagnosticsAudienceProvider, { visible: true }, h(DiagnosticsDisclosure, null, 'gate: mission_held')));
    expect(container.querySelector('[data-testid="diagnostics-disclosure"]')).not.toBeNull();
    expect(container.textContent).toContain('Diagnostics');
    expect(container.textContent).not.toContain('mission_held');
    openAll();
    expect(container.textContent).toContain('gate: mission_held');
  });
});

describe('WaitingLine adopts it', () => {
  it('member: the reason and release stay; gate code, override and source never render', () => {
    render(h(DiagnosticsAudienceProvider, { visible: false }, h(WaitingLine, { reasons: [REASON] })));
    openAll();
    const text = container.textContent ?? '';
    expect(text).toContain('the mission starts a task at most every 10 min');
    expect(text).toContain("starts when the mission's pacing interval passes");
    expect(container.querySelector('[data-testid="task-waiting-diagnostics"]')).toBeNull();
    for (const internal of ['mission_concurrent', 'override', 'claim log', 'claim_loop_deferral', 'Diagnostics', 'forced']) {
      expect(text).not.toContain(internal);
    }
  });

  it('admin or operator: the same reason plus the gate code, override and source', () => {
    render(h(DiagnosticsAudienceProvider, { visible: true }, h(WaitingLine, { reasons: [REASON] })));
    openAll();
    const diag = container.querySelector('[data-testid="task-waiting-diagnostics"]')?.textContent ?? '';
    expect(diag).toContain('mission_concurrent');
    expect(diag).toContain('override: member');
    expect(diag).toContain('Source: claim log');
    expect(diag).toContain('first seen 2026-10-17T10:00:00Z');
    expect(container.textContent).toContain('the mission starts a task at most every 10 min');
  });
});
