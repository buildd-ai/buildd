/**
 * Capability requests through the escalation gate (capability-grants-needs-you.ts)
 * and onto Home: one fixed rule, one card per request, and the card's words.
 */
import { describe, expect, it } from 'bun:test';
import { accessEscalationRule, accessNeedsYouItems, accessPushPayload, accessRequestHref } from './capability-grants-needs-you';
import { buildActionQueue } from './action-queue';
import { deriveHomeAttention } from './home-attention';
import type { AccessRequestView } from './capability-grants-view';

const req = (id: string, over: Partial<AccessRequestView> = {}): AccessRequestView => ({
  id, status: 'pending', capability: 'observability:query', provider: 'axiom', risk: 'query', tool: null, resource: null,
  environment: null, workspaceId: 'ws-1', taskId: 't-1', roleSlug: 'builder', decidedBy: null, ttlSeconds: 3600,
  expiresAt: null, revokedAt: null, reason: 'trace a slow endpoint', taskTitle: 'Fix checkout latency', workspaceName: 'web', ...over,
});

describe('accessEscalationRule', () => {
  it('a pending request is the person\'s, by rule, on the access rail', () => {
    expect(accessEscalationRule(req('r1'))).toMatchObject({ owner: 'person', by: 'rule', rail: 'access_approval' });
  });
  it('an auto-grant and anything decided are Buildd\'s: never a card', () => {
    expect(accessEscalationRule(req('r1', { status: 'granted', decidedBy: 'policy' })).owner).toBe('buildd');
    for (const status of ['granted', 'denied', 'revoked', 'expired'] as const) {
      expect(accessEscalationRule(req('r1', { status, decidedBy: 'human' })).owner).toBe('buildd');
    }
  });
});

describe('accessNeedsYouItems', () => {
  it('only pending requests, once each', () => {
    const items = accessNeedsYouItems([req('r1'), req('r1'), req('g1', { status: 'granted', decidedBy: 'policy' }), req('r2', { risk: 'write' })]);
    expect(items.map(i => i.accessRequestId)).toEqual(['r1', 'r2']);
    expect(items[0]).toMatchObject({
      kind: 'access', accessAsk: 'Query Axiom', accessTtlSeconds: 3600, accessApproveLabel: 'Approve for 1 hour', workspaceName: 'web',
      failureMessage: 'Fix checkout latency in web: "trace a slow endpoint"',
      fixHref: accessRequestHref('r1'),
    });
    expect(items[1].accessAsk).toBe('Write to Axiom');
  });

  it('becomes one ACCESS card on Home with the ask as its title', () => {
    const queue = buildActionQueue(accessNeedsYouItems([req('r1'), req('r1')]), []);
    expect(queue.filter(q => q.chip === 'ACCESS')).toHaveLength(1);
    const home = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
    expect(home).toHaveLength(1);
    expect(home[0]).toMatchObject({
      label: 'access request', actionType: 'access', title: 'Query Axiom', meta: 'web',
      primary: { label: 'Review', href: '/app/settings/apps?request=r1#agent-access' },
    });
  });
});

describe('accessPushPayload', () => {
  it('says what, who and for how long, and links to the request', () => {
    const p = accessPushPayload(req('r1', { environment: 'production' }), 'https://buildd.example');
    expect(p.title).toBe('Access request: Query Axiom · production');
    expect(p.message).toContain('Fix checkout latency in web asks for 1 hour.');
    expect(p.url).toBe('https://buildd.example/app/settings/apps?request=r1#agent-access');
  });
});
