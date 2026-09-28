/**
 * @buildd/shared's chat contract and @builddai/ai-kit's must not drift while
 * both exist (see the TODO(P6) at the top of packages/shared/src/chat.ts).
 * Type parity is checked at compile time by the assignments below; runtime
 * parity by the assertions.
 */
import { describe, expect, it } from 'bun:test';
import * as shared from '@buildd/shared';
import * as kit from '@builddai/ai-kit/chat/contract';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const typeParity: [
  Same<shared.ChatToolPartState, kit.ToolPartState>,
  Same<shared.ChatToolPermissionRow, kit.ToolPermissionRow>,
  Same<shared.ChatApprovalPreview, kit.ApprovalPreview>,
  Same<shared.ChatMessagePart, kit.ChatMessagePart>,
  Same<shared.ChatUsage, kit.ChatUsage>,
  Same<shared.ChatUnavailableReason, kit.ChatUnavailableReason>,
] = [true, true, true, true, true, true];

const preview: shared.ChatApprovalPreview = {
  v: 1, verb: 'Hold task', target: { kind: 'task', id: 't', label: 'checkout', detail: 'running' },
  changes: [{ label: 'Status', before: 'running', after: 'held' }, { label: 'Note', before: null, after: 'x' }],
  fingerprint: 'f',
};

describe('shared ↔ kit chat contract parity', () => {
  it('types match', () => {
    expect(typeParity.every(Boolean)).toBe(true);
  });

  it('approval previews encode, parse and render identically', () => {
    expect(kit.APPROVAL_PREVIEW_PREFIX).toBe(shared.CHAT_PREVIEW_PREFIX);
    expect(kit.encodeApprovalPreview(preview)).toBe(shared.encodeApprovalPreview(preview));
    const enc = shared.encodeApprovalPreview(preview);
    expect(kit.parseApprovalPreview(enc)).toEqual(shared.parseApprovalPreview(enc));
    for (const bad of ['x', `${shared.CHAT_PREVIEW_PREFIX}{`, 7, null]) {
      expect(kit.parseApprovalPreview(bad)).toEqual(shared.parseApprovalPreview(bad));
    }
    expect(kit.approvalHeadline(preview)).toBe(shared.approvalHeadline(preview));
    for (const c of preview.changes) expect(kit.approvalChangeLine(c)).toBe(shared.approvalChangeLine(c));
  });
});
