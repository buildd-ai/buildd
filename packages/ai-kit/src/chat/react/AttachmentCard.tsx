'use client';

/**
 * A long paste, shown as a card instead of inline text (0.25.0): in the
 * composer before it is sent (with Remove), and inside the message that
 * carried it (with Open, for a reader the app supplies). The card has a fixed
 * height in both places, so a message that holds one never changes size while
 * the reply streams under it.
 */
import { attachmentChars, type AttachmentData } from '@builddai/ai-kit/chat/contract';

export interface AttachmentCardProps {
  attachment: AttachmentData;
  /** Composer: take it out of the draft. */
  onRemove?(): void;
  /** Message: open it in a reader. Without it the card is not a button. */
  onOpen?(): void;
  className?: string;
}

export function attachmentSizeLabel(chars: number): string {
  return `${chars.toLocaleString('en-US')} characters`;
}

export function AttachmentCard({ attachment, onRemove, onOpen, className }: AttachmentCardProps) {
  const chars = attachmentChars(attachment);
  const body = (
    <>
      <span className="kit-attachment-kind" aria-hidden="true">TXT</span>
      <span className="kit-attachment-text">
        <span className="kit-attachment-title" data-testid="kit-attachment-title">{attachment.title}</span>
        <span className="kit-attachment-size">Pasted text · {attachmentSizeLabel(chars)}</span>
      </span>
    </>
  );
  return (
    <div className={`kit-attachment${className ? ` ${className}` : ''}`} data-testid="kit-attachment">
      {onOpen ? (
        <button type="button" className="kit-attachment-open" onClick={onOpen} aria-label={`Open ${attachment.title}, ${attachmentSizeLabel(chars)}`} data-testid="kit-attachment-open">
          {body}
        </button>
      ) : (
        <span className="kit-attachment-open">{body}</span>
      )}
      {onRemove && (
        <button type="button" className="kit-attachment-remove" onClick={onRemove} aria-label={`Remove ${attachment.title}`} data-testid="kit-attachment-remove">
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
