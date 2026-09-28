/**
 * What an approval card shows for a proposed write, as data: the server's
 * before → after preview when there is one, else the input's own fields. Pure:
 * it reads the tool input the model proposed and never invents a field the
 * input doesn't carry.
 *
 * An app with a richer card for some writes (buildd's mission draft: goal,
 * criteria, plan) passes `custom`, which is asked first and may return null to
 * fall through to the preview or the fields.
 */
import {
  approvalChangeLine,
  approvalHeadline,
  parseApprovalPreview,
  toolNameOf,
  type ChatToolPart,
} from '@builddai/ai-kit/chat/contract';

/** A write on an existing object: the server's before → after preview. */
export interface PreviewDraft {
  kind: 'preview';
  /** "Hold task: checkout (running)" */
  headline: string;
  changes: Array<{ label: string; before: string | null; after: string | null; line: string }>;
  note: string | null;
  /** Admin writes: type this to confirm. */
  confirmText: string | null;
  workspaceId: string | null;
}

/** No preview: the input's fields, minus `action` and `workspaceId`. */
export interface GenericDraft {
  kind: 'generic';
  fields: Array<{ key: string; value: string }>;
  workspaceId: string | null;
}

export type ApprovalDraft<C extends { kind: string } = never> = PreviewDraft | GenericDraft | C;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The tool input as a record (`{}` when the model sent none). */
export function toolInput(part: ChatToolPart): Record<string, unknown> {
  return (part.input && typeof part.input === 'object' ? part.input : {}) as Record<string, unknown>;
}

/** The `action` of a multi-action tool (`manage_items` with `{ action: 'create' }`), else null. */
export function toolAction(part: ChatToolPart): string | null {
  return str(toolInput(part).action);
}

export function approvalDraft<C extends { kind: string } = never>(
  part: ChatToolPart,
  opts: { custom?(part: ChatToolPart): C | null } = {},
): ApprovalDraft<C> {
  const custom = opts.custom?.(part);
  if (custom) return custom;
  const input = toolInput(part);
  const workspaceId = str(input.workspaceId);
  const preview = parseApprovalPreview(part.approval?.requestReason);
  if (preview) {
    return {
      kind: 'preview',
      headline: approvalHeadline(preview),
      changes: preview.changes.map(c => ({ ...c, line: approvalChangeLine(c) })),
      note: preview.note ?? null,
      confirmText: preview.confirmText ?? null,
      workspaceId: preview.target.workspaceId ?? workspaceId,
    };
  }
  const fields = Object.entries(input)
    .filter(([k]) => k !== 'action' && k !== 'workspaceId')
    .map(([key, v]) => ({ key, value: typeof v === 'string' ? v : JSON.stringify(v) }))
    .filter(f => f.value && f.value !== 'null');
  return { kind: 'generic', fields, workspaceId };
}

/**
 * What the card is, in words ("New task"), never the tool it runs through.
 * `labels` is keyed `tool` or `tool:action`; `tool:action` wins. An unlisted
 * tool reads as its humanised name.
 */
export function approvalLabel(part: ChatToolPart, labels: Readonly<Record<string, string>> = {}): string {
  const name = toolNameOf(part);
  const a = toolAction(part);
  const known = (a && labels[`${name}:${a}`]) || labels[name];
  if (known) return known;
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Change';
}

/** First paragraph of a markdown description, as plain text. */
export function firstParagraph(md: string | null | undefined): string | null {
  if (!md) return null;
  const p = md.split(/\n\s*\n/)[0].replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  return p || null;
}
