import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { KernelSection, ageOf } from './KernelSection';
import type { KernelOperatorView, TransitionRow } from '@/lib/kernel-operator-view';

const NOW = Date.parse('2026-10-18T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function tr(over: Partial<TransitionRow> = {}): TransitionRow {
  return { id: 't1', command: 'record_review_verdict', fromState: 'AWAITING_REVIEW', toState: 'APPROVED', actor: 'system:reviewer', host: 'control-plane', at: ago(5 * 60_000), prNumber: 42, repo: 'acme/app', workspaceId: 'w1', workspaceName: 'alpha', ...over };
}

function view(over: Partial<KernelOperatorView> = {}): KernelOperatorView {
  return {
    query: { window: '24h' }, since: ago(86_400_000), now: NOW, scopeMissing: null,
    transitions: [tr()], web: { count: 0, recent: [] },
    parked: { total: 0, oldestAt: null, byOp: [], gaveUp: 0 },
    floorRuns: [], timeline: { kind: 'idle' }, ...over,
  };
}
const render = (v: KernelOperatorView | null) => renderToStaticMarkup(<KernelSection view={v} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('KernelSection', () => {
  it('renders nothing without a view', () => {
    expect(render(null)).toBe('');
  });

  it('zero on the web host reads as expected, in plain words', () => {
    const html = render(view());
    expect(html).toContain('data-testid="health-section-kernel"');
    expect(html).toMatch(/data-testid="kernel-web-host" data-count="0"/);
    const t = text(html);
    expect(t).toContain('The web host wrote no transitions in the last 24 hours');
    expect(t).toContain('As it should be');
    expect(html).not.toContain('kernel-web-host-recent');
  });

  it('anything on the web host is loud and listed', () => {
    const html = render(view({ web: { count: 2, recent: [tr({ id: 'w', host: 'web', command: 'observe_ci_green' })] } }));
    const t = text(html);
    expect(t).toContain('The web host wrote 2 transitions in the last 24 hours');
    expect(t).toContain('It should be none');
    expect(html).toContain('text-status-error');
    expect(html).toContain('data-testid="kernel-web-host-recent"');
    expect(t).toContain('observe ci green');
    expect(t).toContain('written by the web host');
  });

  it('parked commands: count, oldest age, op, and failing replay', () => {
    const html = render(view({ parked: { total: 3, oldestAt: ago(5 * 3_600_000), gaveUp: 1, byOp: [
      { op: 'attempt_ended', count: 2, oldestAt: ago(5 * 3_600_000), failing: 1, lastError: 'control plane answered 503' },
      { op: 'observe_ci_green', count: 1, oldestAt: ago(60 * 60_000), failing: 0, lastError: null },
    ] } }));
    const t = text(html);
    expect(t).toContain('3 commands are parked, the oldest 5h old.');
    expect(t).toContain('Sending them again is failing for 1.');
    expect(t).toContain('attempt ended 2 waiting, oldest 5h');
    expect(t).toContain('Last error: control plane answered 503');
    expect(t).toContain('The floor gave up on 1 command');
  });

  it('nothing parked says so, and a replay that has not failed says that', () => {
    expect(text(render(view()))).toContain('No commands are parked.');
    const t = text(render(view({ parked: { total: 1, oldestAt: ago(60_000), gaveUp: 0, byOp: [{ op: 'attempt_ended', count: 1, oldestAt: ago(60_000), failing: 0, lastError: null }] } })));
    expect(t).toContain('1 command is parked');
    expect(t).toContain('Sending them again has not failed.');
  });

  it('floor runs: what each repaired, and what it could not', () => {
    const html = render(view({ floorRuns: [
      { id: 'a', startedAt: ago(10 * 60_000), durationMs: 1200, ok: true, host: 'control plane', repaired: ['sent 2 owed effects'], problems: [] },
      { id: 'b', startedAt: ago(70 * 60_000), durationMs: null, ok: true, host: 'web', repaired: [], problems: ['2 open PR heads still without the approval check'] },
    ] }));
    const t = text(html);
    expect(t).toContain('Repaired: sent 2 owed effects.');
    expect(t).toContain('Nothing needed repair.');
    expect(t).toContain('Could not: 2 open PR heads still without the approval check.');
    expect(t).toContain('10m ago');
  });

  it('recent transitions list command, states, PR, workspace, actor and host; filters keep their values', () => {
    const html = render(view({ query: { window: '7d', workspace: 'alpha', command: 'record_review_verdict' } }));
    const t = text(html);
    expect(t).toContain('Recent transitions, filtered');
    expect(t).toContain('record review verdict AWAITING_REVIEW to APPROVED');
    expect(t).toContain('acme/app#42 in alpha, by system:reviewer, written by the control plane');
    expect(html).toContain('name="kworkspace" value="alpha"');
    expect(html).toContain('name="kcommand" value="record_review_verdict"');
    expect(html).toMatch(/<option value="7d" selected/);
    expect(html).toContain('method="get"');
  });

  it('a scope that matches nothing says so instead of listing everything', () => {
    const t = text(render(view({ transitions: [], scopeMissing: 'workspace "zeta"', query: { window: '24h', workspace: 'zeta' } })));
    expect(t).toContain('No workspace &quot;zeta&quot; matches');
  });

  it('a PR timeline: steps in order with evidence, findings and the approval check', () => {
    const html = render(view({ timeline: { kind: 'found', timelines: [{
      deliveryId: 'd1', repo: 'acme/app', prNumber: 42, state: 'AWAITING_REVIEW', stateReason: null, workspaceName: 'alpha',
      steps: [
        { version: 1, command: 'open_delivery', fromState: null, toState: 'WORKING', actor: 'system:floor', host: 'control-plane', at: ago(3 * 3_600_000), evidence: 'source: pr_opened', bypassed: false },
        { version: 2, command: 'record_review_verdict', fromState: 'WORKING', toState: 'AWAITING_REVIEW', actor: 'system:reviewer', host: 'control-plane', at: ago(2 * 3_600_000), evidence: 'verdict: approve', bypassed: true },
      ],
      stepsOmitted: 0, openFindings: ['src/a.ts:12: unchecked null'],
      approval: { state: 'failure', description: 'Unresolved review finding: src/a.ts:12: unchecked null' }, approvalContext: 'Buildd / Review approval',
    }] } }));
    const t = text(html);
    expect(t.indexOf('open delivery')).toBeLessThan(t.indexOf('record review verdict', t.indexOf('open delivery')));
    expect(t).toContain('source: pr_opened');
    expect(t).toContain('with a bypass recorded');
    expect(t).toContain('1 open review finding');
    expect(t).toContain('src/a.ts:12: unchecked null');
    expect(t).toContain('Buildd / Review approval');
    expect(t).toContain('not approved');
  });

  it('a finished PR has no approval check to show; notes for the unanswerable lookups', () => {
    const found = (approval: null) => view({ timeline: { kind: 'found', timelines: [{ deliveryId: 'd', repo: null, prNumber: 7, state: 'MERGED', stateReason: null, workspaceName: 'alpha', steps: [], stepsOmitted: 0, openFindings: [], approval, approvalContext: 'Buildd / Review approval' }] } });
    expect(text(render(found(null)))).toContain('Not shown: the PR is over');
    expect(text(render(found(null)))).toContain('No open review findings.');
    expect(text(render(view({ timeline: { kind: 'needs_workspace' } })))).toContain('Name the workspace too');
    expect(text(render(view({ timeline: { kind: 'not_found', prNumber: 9 } })))).toContain('no delivery for PR #9');
  });

  it('uses no status label-speak', () => {
    const t = text(render(view({ web: { count: 1, recent: [tr({ host: 'web' })] } })));
    expect(t).not.toMatch(/Needs you|Needs input|worker is running/i);
  });
});

describe('ageOf', () => {
  it('says how long ago', () => {
    expect(ageOf(null, NOW)).toBe('never');
    expect(ageOf(ago(30_000), NOW)).toBe('just now');
    expect(ageOf(ago(90 * 60_000), NOW)).toBe('1h ago');
    expect(ageOf(ago(3 * 86_400_000), NOW)).toBe('3d ago');
  });
});
