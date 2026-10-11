'use client';

/**
 * The reader for a long paste (Living Specs C2): reopens an attachment from
 * the message that carried it. It reads the stored text in pages of at most
 * 20,000 characters (`GET /api/chat/[id]/attachments/[artifactId]?view=range`),
 * so a 200,000-character paste never lands in the page at once; "Show more"
 * appends the next page. A paste still on its way (no artifact yet) is read
 * from the draft the browser holds.
 */
import { useCallback, useEffect, useState } from 'react';
import { isAttachmentDraft, type AttachmentData } from '@builddai/ai-kit/chat/contract';
import { attachmentSizeLabel } from '@builddai/ai-kit/chat/react';
import Sheet from '@/components/ui/Sheet';

export const READER_PAGE_CHARS = 20_000;

interface RangeRead { view: 'range'; chars: number; offset: number; length: number; text: string }

export function AttachmentReader({ conversationId, attachment, onClose }: {
  conversationId: string | null;
  attachment: AttachmentData;
  onClose(): void;
}) {
  const draft = isAttachmentDraft(attachment) ? attachment : null;
  const stored = isAttachmentDraft(attachment) ? null : attachment;
  const total = draft ? draft.text.length : stored!.chars;
  const [text, setText] = useState(draft ? draft.text.slice(0, READER_PAGE_CHARS) : '');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (offset: number) => {
    if (draft) { setText(draft.text.slice(0, offset + READER_PAGE_CHARS)); return; }
    if (!conversationId || !stored) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/chat/${encodeURIComponent(conversationId)}/attachments/${encodeURIComponent(stored.artifactId)}?view=range&offset=${offset}&length=${READER_PAGE_CHARS}`,
        { credentials: 'include', cache: 'no-store' },
      );
      if (!res.ok) throw new Error(res.status === 404 ? 'This attachment is no longer available.' : 'The attachment could not be read. Try again.');
      const { read } = (await res.json()) as { read: RangeRead };
      setText(prev => (offset === 0 ? read.text : prev + read.text));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The attachment could not be read. Try again.');
    } finally {
      setLoading(false);
    }
  }, [stored, conversationId, draft]);

  useEffect(() => { if (!draft) void load(0); }, [draft, load]);

  const more = text.length < total;
  return (
    <Sheet open onClose={onClose} title={attachment.title} height="tall" testId="attachment-reader">
      <p className="mb-3 font-mono text-[12px] text-text-muted" data-testid="attachment-reader-meta">
        Pasted text · {attachmentSizeLabel(total)}
        {stored && <span className="block break-all">sha256 {stored.sha256}</span>}
      </p>
      {error && <p role="alert" className="mb-3 text-[14px] text-text-primary">{error}</p>}
      <pre data-testid="attachment-reader-text" className="whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.5] text-text-primary [overflow-wrap:anywhere]">
        {text}
      </pre>
      {more && (
        <button
          type="button"
          className="mt-4 min-h-11 border border-border-strong px-4 font-mono text-[13px] text-text-primary"
          disabled={loading}
          onClick={() => void load(text.length)}
          data-testid="attachment-reader-more"
        >
          {loading ? 'Loading…' : `Show more (${(total - text.length).toLocaleString('en-US')} characters left)`}
        </button>
      )}
    </Sheet>
  );
}
