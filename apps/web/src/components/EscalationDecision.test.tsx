import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

const { default: EscalationDecision } = await import('./EscalationDecision');
type Brief = Parameters<typeof EscalationDecision>[0]['brief'];

const action = (id: string, available: boolean, unavailableReason: string | null = null) =>
  ({ id, label: id === 'approve_override' ? 'Approve and override' : id, impact: `impact of ${id}`, requires: 'something', available, unavailableReason });

const brief = (override: { available: boolean; reason?: string | null }): Brief => ({
  cause: 'fixes_exhausted', title: 'Automated fixes exhausted', summary: 'Findings remain.',
  findings: { open: [], addressedAwaitingVerification: [], resolved: [], waived: [], deferred: [] },
  totals: { open: 1, addressedAwaitingVerification: 0, verifiedResolved: 0, waived: 0, deferred: 0 },
  decisionHead: { headSha: 'abc123', version: 7 },
  actions: [action('request_fix', true), action('approve_override', override.available, override.reason ?? null)],
} as unknown as Brief);

const render = (b: Brief) => renderToStaticMarkup(<EscalationDecision brief={b} prNumber={12} workspaceId="ws" />);

describe('EscalationDecision approve_override', () => {
  it('offers an enabled action to a permitted viewer', () => {
    const html = render(brief({ available: true }));
    expect(html).toContain('data-testid="decision-action-approve_override"');
    const btn = html.split('data-testid="decision-action-approve_override"')[1].match(/<button[^>]*>/)![0];
    expect(btn).not.toContain('disabled=""');
    expect(html).not.toContain('Unavailable:');
  });

  it('shows it disabled with the brief\'s own sentence otherwise', () => {
    const html = render(brief({ available: false, reason: 'You do not hold merge permission on this repo.' }));
    const btn = html.split('data-testid="decision-action-approve_override"')[1].match(/<button[^>]*>/)![0];
    expect(btn).toContain('disabled=""');
    expect(html).toContain('Unavailable: You do not hold merge permission on this repo.');
  });
});
