'use client';

/**
 * A long paste, shown as a card instead of inline text (0.25.0): in the
 * composer before it is sent (with Remove), and inside the message that
 * carried it (with Open, for a reader the app supplies). The card has a fixed
 * height in both places, so a message that holds one never changes size while
 * the reply streams under it.
 */
import { attachmentChars, fileKindLabel, fileSizeLabel, isImageMediaType, type AttachmentData } from '@builddai/ai-kit/chat/contract';

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

export interface FileCardProps {
  name: string;
  mediaType: string;
  sizeBytes: number;
  /** `uploading` and `failed` never read as attached: no Open, and the state says so. */
  state?: 'uploading' | 'failed' | 'ready';
  /** Why it failed, in a few words. */
  error?: string;
  /** A thumbnail for an image: a browser-local preview in the composer, the stored original in a message. */
  imageUrl?: string;
  onRemove?(): void;
  /** A failed upload that can be tried again. */
  onRetry?(): void;
  onOpen?(): void;
  className?: string;
}

/**
 * An image or file (0.26.0), with the same fixed height as a paste's card. In
 * the composer it shows its upload state; only a ready one is ever sent.
 */
export function FileCard({ name, mediaType, sizeBytes, state = 'ready', error, imageUrl, onRemove, onRetry, onOpen, className }: FileCardProps) {
  const kind = fileKindLabel(mediaType);
  const detail = state === 'uploading' ? 'Uploading…' : state === 'failed' ? (error ?? 'Upload failed') : `${kind} · ${fileSizeLabel(sizeBytes)}`;
  const body = (
    <>
      {imageUrl && isImageMediaType(mediaType)
        ? <img className="kit-file-thumb" src={imageUrl} alt="" data-testid="kit-file-thumb" />
        : <span className="kit-attachment-kind" aria-hidden="true">{kind}</span>}
      <span className="kit-attachment-text">
        <span className="kit-attachment-title" data-testid="kit-attachment-title">{name}</span>
        <span className="kit-attachment-size" data-testid="kit-file-state">{detail}</span>
      </span>
    </>
  );
  const openable = state === 'ready' && onOpen;
  return (
    <div className={`kit-attachment${className ? ` ${className}` : ''}`} data-testid="kit-file" data-state={state}>
      {openable ? (
        <button type="button" className="kit-attachment-open" onClick={onOpen} aria-label={`Open ${name}, ${fileSizeLabel(sizeBytes)}`} data-testid="kit-attachment-open">
          {body}
        </button>
      ) : (
        <span className="kit-attachment-open" aria-busy={state === 'uploading' || undefined}>{body}</span>
      )}
      {state === 'failed' && onRetry && (
        <button type="button" className="kit-attachment-retry" onClick={onRetry} aria-label={`Retry ${name}`} data-testid="kit-file-retry">
          Retry
        </button>
      )}
      {onRemove && (
        <button type="button" className="kit-attachment-remove" onClick={onRemove} aria-label={`Remove ${name}`} data-testid="kit-attachment-remove">
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
