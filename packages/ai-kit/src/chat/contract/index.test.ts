import { describe, expect, it } from 'bun:test';
import {
  APPROVAL_PREVIEW_PREFIX, approvalChangeLine, approvalHeadline, encodeApprovalPreview, isHandoffPart,
  isObjectRefOf, isStepPart, isTextPart, isToolPart, parseApprovalPreview, toolNameOf,
  type ApprovalPreview, type ChatPart,
} from './index';

const preview: ApprovalPreview = {
  v: 1, verb: 'Hold task', target: { kind: 'task', id: 't1', label: 'checkout', detail: 'running' },
  changes: [{ label: 'Status', before: 'running', after: 'held' }], fingerprint: 'f',
};

describe('approval previews', () => {
  it('round-trips through the request reason', () => {
    const enc = encodeApprovalPreview(preview);
    expect(enc.startsWith(APPROVAL_PREVIEW_PREFIX)).toBe(true);
    expect(parseApprovalPreview(enc)).toEqual(preview);
  });
  it('keeps the wire prefix stable', () => {
    expect(APPROVAL_PREVIEW_PREFIX).toBe('buildd-preview:');
  });
  it('rejects anything else', () => {
    expect(parseApprovalPreview('nope')).toBeNull();
    expect(parseApprovalPreview(`${APPROVAL_PREVIEW_PREFIX}{bad json`)).toBeNull();
    expect(parseApprovalPreview(`${APPROVAL_PREVIEW_PREFIX}${JSON.stringify({ ...preview, v: 2 })}`)).toBeNull();
    expect(parseApprovalPreview(42)).toBeNull();
  });
  it('renders headline and change lines', () => {
    expect(approvalHeadline(preview)).toBe('Hold task: checkout (running)');
    expect(approvalChangeLine({ label: 'Criteria', before: null, after: 'e2e' })).toBe('Criteria: + e2e');
    expect(approvalChangeLine({ label: 'Criteria', before: 'e2e', after: null })).toBe('Criteria: − e2e');
    expect(approvalChangeLine({ label: 'Status', before: 'a', after: 'b' })).toBe('Status: a → b');
  });
});

describe('parts', () => {
  it('narrows tool and text parts', () => {
    const tool: ChatPart = { type: 'tool-list_tasks', toolCallId: 'c', state: 'output-available' };
    const dyn: ChatPart = { type: 'dynamic-tool', toolName: 'x', toolCallId: 'c', state: 'input-available' };
    expect(isToolPart(tool) && toolNameOf(tool)).toBe('list_tasks');
    expect(isToolPart(dyn) && toolNameOf(dyn)).toBe('x');
    expect(isToolPart({ type: 'tool-x' })).toBe(false);
    expect(isTextPart({ type: 'text', text: 'hi' })).toBe(true);
    expect(isTextPart({ type: 'text' })).toBe(false);
  });
  it('validates data-step and data-handoff parts', () => {
    expect(isStepPart({ type: 'data-step', data: { id: 's', label: 'Read tasks', state: 'done' } })).toBe(true);
    expect(isStepPart({ type: 'data-step', data: { id: 's', label: 'x', state: 'weird' } })).toBe(false);
    expect(isHandoffPart({ type: 'data-handoff', data: { taskId: 't', url: 'u', state: 'filed' } })).toBe(true);
    expect(isHandoffPart({ type: 'data-handoff', data: {} })).toBe(false);
  });
  it('object refs are checked against the declared kinds', () => {
    const kinds = ['shipment', 'order'] as const;
    expect(isObjectRefOf(kinds, { kind: 'order', id: '1', workspaceId: null, fallbackText: 'Order 1' })).toBe(true);
    expect(isObjectRefOf(kinds, { kind: 'mission', id: '1', fallbackText: 'x' })).toBe(false);
    expect(isObjectRefOf(kinds, { kind: 'order', id: 1, fallbackText: 'x' })).toBe(false);
  });
});
