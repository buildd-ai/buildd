/**
 * The approval-request push (Living Spec b7fc9316 R-10, AC-10): it reaches
 * only the people who may approve that spec, each on their own key. Who
 * counts as an approver is real-Postgres tested in
 * tests/db/spec-approval-inbox.test.ts (specApproverIds).
 */
import { describe, expect, it } from 'bun:test';
import { notifySpecApprovers, type SpecApprovalNotifyDeps } from './spec-approval-notify';
import type { PushoverMessage } from './personal-pushover';

const N = { workspaceId: 'w1', title: 'Checkout', revision: 3, confirmUrl: 'https://buildd.dev/app/specs/s1/approve?request=tok', warnings: 1 };

function deps(over: Partial<SpecApprovalNotifyDeps> = {}) {
  const sent: PushoverMessage[] = [];
  const keys: Record<string, string> = { admin: 'key-admin', delegate: 'key-delegate', member: 'key-member' };
  const d: SpecApprovalNotifyDeps = {
    approvers: async () => ['admin', 'delegate'],
    teamOf: async () => 't1',
    keyOf: async (u) => keys[u] ?? null,
    send: async (m) => { sent.push(m); },
    senderToken: () => 'app-token',
    ...over,
  };
  return { d, sent };
}

describe('notifySpecApprovers', () => {
  it('AC-10: sends to each approver\'s own key and to nobody else on the team', async () => {
    const { d, sent } = deps();
    expect((await notifySpecApprovers(N, d)).sort()).toEqual(['admin', 'delegate']);
    expect(sent.map((m) => m.user).sort()).toEqual(['key-admin', 'key-delegate']);
    expect(sent[0]).toMatchObject({ token: 'app-token', url: N.confirmUrl, title: 'Approve "Checkout"?' });
  });

  it('an approver with no key of their own gets no push', async () => {
    const { d, sent } = deps({ approvers: async () => ['admin', 'nokey'] });
    expect(await notifySpecApprovers(N, d)).toEqual(['admin']);
    expect(sent).toHaveLength(1);
  });

  it('no sender configured, or no approvers: nothing is sent', async () => {
    const a = deps({ senderToken: () => null });
    expect(await notifySpecApprovers(N, a.d)).toEqual([]);
    const b = deps({ approvers: async () => [] });
    expect(await notifySpecApprovers(N, b.d)).toEqual([]);
    expect([...a.sent, ...b.sent]).toEqual([]);
  });
});
