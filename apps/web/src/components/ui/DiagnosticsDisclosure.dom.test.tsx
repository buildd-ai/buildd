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
  kind: 'pr_overlap_live',
  class: 'coordination',
  strength: 'hard',
  intent: 'intentional',
  blocker: { type: 'pr', id: 'pr-1', label: 'PR #12', href: 'https://github.com/o/r/pull/12' },
  provenance: { source: 'ledger', derivedFrom: 'claim_loop_deferral', firstSeenAt: '2026-10-17T10:00:00Z' },
  because: 'both edit packages/core/db/schema.ts',
  releasesWhen: { event: 'path_claim.released', text: 'that PR merges, closes or narrows its files' },
  action: { owner: 'agent', force: { scope: 'member', lifts: 'pr_overlap_live', railsRemaining: [], mechanism: 'start_context' } },
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
    expect(text).toContain('both edit packages/core/db/schema.ts');
    expect(text).toContain('starts when that PR merges');
    expect(container.querySelector('[data-testid="task-waiting-diagnostics"]')).toBeNull();
    for (const internal of ['pr_overlap_live', 'override', 'claim log', 'claim_loop_deferral', 'Diagnostics', 'forced']) {
      expect(text).not.toContain(internal);
    }
  });

  it('admin or operator: the same reason plus the gate code, override and source', () => {
    render(h(DiagnosticsAudienceProvider, { visible: true }, h(WaitingLine, { reasons: [REASON] })));
    openAll();
    const diag = container.querySelector('[data-testid="task-waiting-diagnostics"]')?.textContent ?? '';
    expect(diag).toContain('pr_overlap_live');
    expect(diag).toContain('override: member');
    expect(diag).toContain('Source: claim log');
    expect(diag).toContain('first seen 2026-10-17T10:00:00Z');
    expect(container.textContent).toContain('both edit packages/core/db/schema.ts');
  });
});
