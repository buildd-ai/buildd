'use client';

/**
 * The composer: the message box, the toolbar slots (scope, tools, tier) and
 * Send, which becomes Stop while a turn streams. With `onSteer`, typing while
 * busy steers the running turn ("applies at the next step") instead of being
 * held; without it, Enter does nothing until the turn ends.
 *
 * Controlled (`value` + `onChange`) or uncontrolled. Enter sends, Shift+Enter
 * is a new line, and an IME composition never sends.
 */
import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import {
  FILE_MEDIA_TYPES, MAX_FILE_BYTES, attachmentChars, fileMediaType, fileSizeLabel, isFileDraft, isImageMediaType, pasteTitle,
  type DraftAttachment, type FileDraft,
} from '@builddai/ai-kit/chat/contract';
import { AttachmentCard, FileCard } from './AttachmentCard';

export interface ChatComposerHandle {
  focus(): void;
  /** Replace the draft (e.g. a chip that prefills) and focus the end. */
  prefill(text: string): void;
}

export interface ChatComposerProps {
  /**
   * `attachments`: the long pastes (0.25.0) and uploaded files (0.26.0) in the
   * draft, empty when there are none. A file is here only once its upload is
   * ready; Send waits while one is still uploading or has failed.
   */
  onSend(text: string, attachments: DraftAttachment[]): void;
  /** Stop the running turn. Without it, the Stop button is disabled. */
  onStop?(): void;
  /** A turn is streaming. */
  busy?: boolean;
  disabled?: boolean;
  value?: string;
  defaultValue?: string;
  onChange?(value: string): void;
  placeholder?: string;
  /** Steer the running turn. When set, the busy placeholder invites it. */
  onSteer?(text: string): void;
  busyPlaceholder?: string;
  /** Toolbar slots: e.g. `<ScopePicker>`, `<ToolsMenu>`, `<TierPicker>`. */
  scope?: ReactNode;
  tools?: ReactNode;
  tier?: ReactNode;
  /** "Fill in a form instead": a link (`formFallbackHref`) or any node (`formFallback`). */
  formFallbackHref?: string;
  formFallback?: ReactNode;
  formFallbackLabel?: string;
  /** Show the form fallback. Pass `messages.length === 0`: it shows until the first message. */
  showFormFallback?: boolean;
  /** Accessible name of the message box. */
  label?: string;
  autoFocus?: boolean;
  className?: string;
  /**
   * A row inside the box, above the message: e.g. a chip for the object the
   * message is about, or a locked scope. Nothing renders without it.
   */
  leading?: ReactNode;
  /** Extra toolbar controls, after `tier` and before Send (e.g. attach, a voice button). */
  actions?: ReactNode;
  /** Decoration drawn inside the box, over its top edge (e.g. a streaming sweep). Hidden from assistive tech. */
  edge?: ReactNode;
  /** Under the box, after the form fallback (e.g. keyboard hints). */
  footer?: ReactNode;
  /** An app-defined mood on the box as `data-mood` (e.g. `needs` to tint its rule). */
  mood?: string | null;
  /** A shorter box, for a narrow docked column (`data-compact`). */
  compact?: boolean;
  /**
   * The message box's `id` (0.9.0), for an app that focuses it from elsewhere
   * (a keyboard shortcut). Default: a generated id.
   */
  inputId?: string;
  /**
   * Longest message Send accepts, in characters (0.23.0). Near it a count
   * shows; past it Send does nothing and the draft stays, so a long paste is
   * never lost to a refusal. No limit without it.
   */
  maxLength?: number;
  /**
   * A paste longer than this many characters becomes an attachment card above
   * the message instead of text in the box (0.25.0; `PASTE_ATTACHMENT_CHARS`
   * is the shared default). Without it every paste goes into the box.
   * `maxLength` counts the text and the attachments together.
   */
  attachFrom?: number;
  /** Controlled attachments (with `onAttachmentsChange`), e.g. to keep them across a refused send. */
  attachments?: DraftAttachment[];
  onAttachmentsChange?(attachments: DraftAttachment[]): void;
  /**
   * Upload one image or file (0.26.0): paste, drop and an Attach button go
   * through it. Resolve with the verified upload once its bytes are stored and
   * checked; reject (or abort on `signal`) and the card shows it failed, never
   * attached. Without it the composer takes no files.
   */
  onUploadFile?(file: File, signal: AbortSignal): Promise<FileDraft>;
  /** A ready file taken out of the draft before it was sent (e.g. to delete the upload). */
  onDiscardFile?(file: FileDraft): void;
  /** Media types a file may have. Default: `FILE_MEDIA_TYPES`. */
  fileTypes?: readonly string[];
  /** Largest file, in bytes. Default: `MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

/** A file on its way up: never in `attachments`, so never sent, until it is ready. */
interface Upload {
  key: string;
  file: File;
  state: 'uploading' | 'failed';
  error?: string;
  /** A refusal before any upload (type, size) cannot be retried. */
  retryable: boolean;
  previewUrl?: string;
  controller?: AbortController;
}

/** The count appears once a draft reaches this share of `maxLength`. */
export const COMPOSER_COUNT_FROM = 0.9;

export const DEFAULT_BUSY_PLACEHOLDER = 'Steer while I think…';

/** Fixed at paste: a retry sends the same id, so the server keeps one attachment per paste. */
function newAttachmentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  const h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  return `${h()}${h()}-${h()}-4${h().slice(1)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${h().slice(1)}-${h()}${h()}${h()}`;
}

export const ChatComposer = forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer({
  onSend, onStop, busy = false, disabled = false, value, defaultValue = '', onChange,
  placeholder = 'Ask anything…', onSteer, busyPlaceholder = DEFAULT_BUSY_PLACEHOLDER,
  scope, tools, tier, formFallbackHref, formFallback, formFallbackLabel = 'Fill in a form instead',
  showFormFallback = true, label = 'Message', autoFocus, className,
  leading, actions, edge, footer, mood = null, compact = false, inputId: inputIdProp, maxLength,
  attachFrom, attachments: attachmentsProp, onAttachmentsChange,
  onUploadFile, onDiscardFile, fileTypes = FILE_MEDIA_TYPES, maxFileBytes = MAX_FILE_BYTES,
}, ref) {
  const [inner, setInner] = useState(defaultValue);
  const [steerSent, setSteerSent] = useState(false);
  const controlled = value !== undefined;
  const text = controlled ? value : inner;
  const [innerAttachments, setInnerAttachments] = useState<DraftAttachment[]>([]);
  const attachments = attachmentsProp ?? innerAttachments;
  // The latest list, so an upload that resolves later appends to what is there then.
  const latest = useRef(attachments);
  latest.current = attachments;
  const setAttachments = (a: DraftAttachment[]) => {
    latest.current = a;
    if (attachmentsProp === undefined) setInnerAttachments(a);
    onAttachmentsChange?.(a);
  };
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dropping, setDropping] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  // Unmounting cancels what is still uploading.
  useEffect(() => () => { for (const u of uploadsRef.current) u.controller?.abort(); }, []);
  const patchUpload = (key: string, patch: Partial<Upload> | null) => setUploads(list => (
    patch === null ? list.filter(u => u.key !== key) : list.map(u => (u.key === key ? { ...u, ...patch } : u))
  ));
  const startUpload = (key: string, file: File, previewUrl: string | undefined) => {
    if (!onUploadFile) return;
    const controller = new AbortController();
    patchUpload(key, { state: 'uploading', error: undefined, controller });
    onUploadFile(file, controller.signal).then(
      draft => {
        if (controller.signal.aborted) return;
        patchUpload(key, null);
        setAttachments([...latest.current, { ...draft, ...(previewUrl ? { previewUrl } : {}) }]);
      },
      (e: unknown) => {
        if (controller.signal.aborted) return;
        patchUpload(key, { state: 'failed', error: e instanceof Error && e.message ? e.message : 'Upload failed', controller: undefined });
      },
    );
  };
  const addFiles = (files: readonly File[]) => {
    if (!onUploadFile || files.length === 0) return;
    const added: Upload[] = files.map(file => {
      const key = newAttachmentId();
      const type = fileMediaType(file.type);
      const allowed = !!type && fileTypes.includes(type);
      const previewUrl = allowed && isImageMediaType(type!) && typeof URL !== 'undefined' && 'createObjectURL' in URL ? URL.createObjectURL(file) : undefined;
      if (!allowed) return { key, file, state: 'failed', error: 'File type not supported', retryable: false };
      if (file.size > maxFileBytes) return { key, file, state: 'failed', error: `Over ${fileSizeLabel(maxFileBytes)}`, retryable: false };
      if (file.size === 0) return { key, file, state: 'failed', error: 'Empty file', retryable: false };
      return { key, file, state: 'uploading', retryable: true, previewUrl };
    });
    setUploads(list => [...list, ...added]);
    for (const u of added) if (u.state === 'uploading') startUpload(u.key, u.file, u.previewUrl);
  };
  const removeUpload = (u: Upload) => {
    u.controller?.abort();
    patchUpload(u.key, null);
  };
  const removeAttachment = (a: DraftAttachment) => {
    setAttachments(attachments.filter(x => x.id !== a.id));
    if (isFileDraft(a)) onDiscardFile?.(a);
  };
  const area = useRef<HTMLTextAreaElement>(null);
  const generatedId = useId();
  const inputId = inputIdProp ?? generatedId;
  const hintId = useId();
  const countId = useId();

  const set = (v: string) => {
    if (!controlled) setInner(v);
    onChange?.(v);
  };
  const focusEnd = () => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  };
  useImperativeHandle(ref, () => ({
    focus: focusEnd,
    prefill(t: string) {
      set(t);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(focusEnd); else focusEnd();
    },
  }));

  const attachedChars = attachments.reduce((n, a) => n + (isFileDraft(a) ? 0 : attachmentChars(a)), 0);
  const total = text.trim().length + attachedChars;
  const over = maxLength !== undefined && total > maxLength;
  // A file still uploading or failed holds Send: it is never sent unready, and never silently left out.
  const waiting = uploads.length > 0;
  const submit = () => {
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled || over || waiting) return;
    if (busy) {
      // Steering is a short instruction; an attachment waits for the next send.
      if (!onSteer || !t || attachments.length > 0) return;
      onSteer(t);
      setSteerSent(true);
      set('');
      return;
    }
    setSteerSent(false);
    onSend(t, attachments);
    set('');
    setAttachments([]);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (onUploadFile && files.length > 0) {
      e.preventDefault();
      addFiles(files);
      return;
    }
    if (attachFrom === undefined) return;
    const pasted = e.clipboardData?.getData('text/plain') ?? '';
    if (pasted.length <= attachFrom) return;
    e.preventDefault();
    setAttachments([...attachments, { id: newAttachmentId(), title: pasteTitle(pasted), text: pasted }]);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  const dropProps = onUploadFile ? {
    onDragOver: (e: DragEvent<HTMLFormElement>) => { if (!hasFiles(e)) return; e.preventDefault(); setDropping(true); },
    onDragLeave: () => setDropping(false),
    onDrop: (e: DragEvent<HTMLFormElement>) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropping(false);
      addFiles(Array.from(e.dataTransfer.files ?? []));
    },
  } : {};
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    addFiles(Array.from(e.target.files ?? []));
    e.target.value = '';
  };

  const steering = busy && !!onSteer;
  const empty = !text.trim() && attachments.length === 0;
  const showCount = maxLength !== undefined && total >= maxLength * COMPOSER_COUNT_FROM;
  return (
    <div className={`kit-chat${className ? ` ${className}` : ''}`}>
      <form
        className="kit-composer"
        data-busy={busy || undefined}
        data-mood={mood || undefined}
        data-compact={compact || undefined}
        data-testid="kit-composer"
        data-dropping={dropping || undefined}
        onSubmit={e => { e.preventDefault(); submit(); }}
        {...dropProps}
      >
        {edge != null && edge !== false && <span className="kit-composer-edge" aria-hidden="true" data-testid="kit-composer-edge">{edge}</span>}
        {leading != null && leading !== false && <div className="kit-composer-leading" data-testid="kit-composer-leading">{leading}</div>}
        {(attachments.length > 0 || uploads.length > 0) && (
          <div className="kit-composer-attachments" data-testid="kit-composer-attachments">
            {attachments.map(a => (isFileDraft(a)
              ? <FileCard key={a.id} name={a.name} mediaType={a.mediaType} sizeBytes={a.sizeBytes} {...(a.previewUrl ? { imageUrl: a.previewUrl } : {})} onRemove={() => removeAttachment(a)} />
              : <AttachmentCard key={a.id} attachment={a} onRemove={() => removeAttachment(a)} />))}
            {uploads.map(u => (
              <FileCard
                key={u.key}
                name={u.file.name || 'file'}
                mediaType={fileMediaType(u.file.type) ?? (u.file.type || 'application/octet-stream')}
                sizeBytes={u.file.size}
                state={u.state}
                {...(u.error ? { error: u.error } : {})}
                {...(u.previewUrl ? { imageUrl: u.previewUrl } : {})}
                {...(u.state === 'failed' && u.retryable ? { onRetry: () => startUpload(u.key, u.file, u.previewUrl) } : {})}
                onRemove={() => removeUpload(u)}
              />
            ))}
          </div>
        )}
        <label htmlFor={inputId} className="kit-sr-only">{label}</label>
        <textarea
          id={inputId}
          ref={area}
          className="kit-composer-input"
          rows={2}
          value={text}
          disabled={disabled}
          autoFocus={autoFocus}
          onChange={e => set(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          placeholder={steering ? busyPlaceholder : placeholder}
          aria-describedby={[steering ? hintId : null, showCount ? countId : null].filter(Boolean).join(' ') || undefined}
          data-testid="kit-composer-input"
        />
        {showCount && (
          <p id={countId} className="kit-composer-count" data-over={over || undefined} aria-live="polite" data-testid="kit-composer-count">
            {total.toLocaleString('en-US')} / {maxLength!.toLocaleString('en-US')} characters{over ? '. Shorten it to send.' : ''}
          </p>
        )}
        {steering && (
          <p id={hintId} className="kit-steer-hint" aria-live="polite">
            {steerSent ? 'Sent. It applies at the next step.' : 'What you send now applies at the next step.'}
          </p>
        )}
        <div className="kit-toolbar">
          <div className="kit-toolbar-slot" data-slot="scope">{scope}</div>
          {tools && <div className="kit-toolbar-slot" data-slot="tools">{tools}</div>}
          {tier && <div className="kit-toolbar-slot" data-slot="tier">{tier}</div>}
          {onUploadFile && (
            <div className="kit-toolbar-slot" data-slot="attach">
              <button type="button" className="kit-attach" aria-label="Attach a file" onClick={() => picker.current?.click()} disabled={disabled} data-testid="kit-attach">
                <span aria-hidden="true">+</span>
              </button>
              <input ref={picker} type="file" multiple accept={fileTypes.join(',')} className="kit-sr-only" tabIndex={-1} aria-hidden="true" onChange={onPick} data-testid="kit-attach-input" />
            </div>
          )}
          {actions != null && actions !== false && <div className="kit-toolbar-slot" data-slot="actions">{actions}</div>}
          {busy && !(steering && !empty) ? (
            <button type="button" className="kit-stop" aria-label="Stop" disabled={!onStop} onClick={() => onStop?.()} data-testid="kit-stop">
              <span aria-hidden="true" className="kit-stop-mark" />
            </button>
          ) : (
            <button
              type="submit"
              className="kit-send"
              aria-label={steering ? 'Steer' : 'Send'}
              // Not dimmed: a faded arrow fails contrast. Assistive tech hears it; submit() ignores it.
              aria-disabled={disabled || empty || over || waiting ? true : undefined}
              data-testid="kit-send"
            >
              <span aria-hidden="true">↑</span>
            </button>
          )}
        </div>
      </form>
      {showFormFallback && (formFallback ?? (formFallbackHref ? (
        <a className="kit-form-fallback" href={formFallbackHref} data-testid="kit-form-fallback">{formFallbackLabel}</a>
      ) : null))}
      {footer != null && footer !== false && <div className="kit-composer-footer" data-testid="kit-composer-footer">{footer}</div>}
    </div>
  );
});
