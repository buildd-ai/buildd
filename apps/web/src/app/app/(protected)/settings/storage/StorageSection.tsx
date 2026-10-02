'use client';

import { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '@/components/useConfirm';
import ConnectionRow, { StatusChip } from '../_components/ConnectionRow';
import SettingsSection from '../SettingsSection';
import BackendForm, { type ScopeOption } from './BackendForm';
import {
  PROVIDER_LABELS,
  SSE_LABELS,
  formatBytes,
  lifecycleSnippet,
  statusChip,
  toCreateBody,
  toUpdateBody,
  type StorageBackend,
  type StorageForm,
} from './_lib/storage-form';

interface Workspace {
  id: string;
  name: string;
}

interface Verification {
  status: 'ok' | 'failing';
  error: string | null;
  warnings?: string[];
}

/** `backendId`: the row the message is about; it shows inside that row when open, next to its buttons. */
type Message = { type: 'success' | 'error'; text: string; backendId?: string };

/**
 * A copyable snippet. JSON keeps its lines and scrolls sideways rather than
 * breaking a key mid-word (the shared CopyBlock breaks anywhere); a command
 * wraps at spaces.
 */
function SnippetBlock({ label, text, wrap }: { label: string; text: string; wrap: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked: the text is still selectable */ }
  }
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs text-text-secondary">{label}</span>
        <button type="button" onClick={copy} className="btn btn-quiet" aria-label={`Copy ${label}`}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={`bg-surface-4 text-text-primary p-3 text-xs ${wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto'}`}>
        {text}
      </pre>
    </div>
  );
}

function MessageLine({ message }: { message: Message }) {
  return (
    <div role="status" data-testid="storage-message"
      className={`text-sm break-words ${message.type === 'error' ? 'text-status-error' : 'text-status-success'}`}>
      {message.text}
    </div>
  );
}

/**
 * A failed check stores its error as the backend's lastError, which the row
 * already shows in its own notice. Say the check just failed instead of
 * repeating the same sentence under the buttons.
 */
function rowMessage(message: Message, b: StorageBackend): Message {
  if (message.type === 'error' && b.lastError && b.status !== 'ok' && message.text.includes(b.lastError)) {
    // Keep anything after the error (verify warnings, e.g. a publicly readable probe).
    const rest = message.text.slice(message.text.indexOf(b.lastError) + b.lastError.length).trim();
    return { ...message, text: `The check failed just now. The error is shown above.${rest ? ` ${rest}` : ''}` };
  }
  return message;
}

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

function verificationMessage(prefix: string, v: Verification | undefined): Message {
  if (!v) return { type: 'success', text: `${prefix}.` };
  const warn = v.warnings?.length ? ` ${v.warnings.join(' ')}` : '';
  return v.status === 'ok'
    ? { type: 'success', text: `${prefix} and verified.${warn}` }
    : { type: 'error', text: `${prefix}, but the check failed: ${v.error ?? 'unknown error'}${warn}` };
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try { return await res.json(); } catch { return {}; }
}

/**
 * Settings → Storage: where the team's run evidence is written. One row per
 * backend (team default first, then workspace ones), each with its status,
 * last error and last check, and the lifecycle rule to paste into the bucket.
 * Admins and owners can add, edit, verify and remove; everyone else reads.
 *
 * What the browser holds is the DTO from /api/evidence-backends, rendered
 * field by field. A credential is only ever "set" or "not set".
 */
export default function StorageSection({ workspaces, fixture }: {
  workspaces: Workspace[];
  /**
   * Dev fixtures only (/app/dev/fixtures?state=evidence-storage): start from
   * this data and UI state instead of loading, so a screenshot reaches an
   * open row, the edit form and the add form.
   */
  fixture?: {
    backends: StorageBackend[]; canManage: boolean; openId?: string; editingId?: string; adding?: boolean;
    busy?: boolean; message?: Message;
  };
}) {
  const { confirm, confirmDialog } = useConfirm();
  const [backends, setBackends] = useState<StorageBackend[]>(fixture?.backends ?? []);
  const [canManage, setCanManage] = useState(fixture?.canManage ?? false);
  const [loading, setLoading] = useState(!fixture);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(fixture?.openId ?? null);
  const [editingId, setEditingId] = useState<string | null>(fixture?.editingId ?? null);
  const [adding, setAdding] = useState(fixture?.adding ?? false);
  const [busy, setBusy] = useState(fixture?.busy ?? false);
  const [message, setMessage] = useState<Message | null>(fixture?.message ?? null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/evidence-backends');
      const data = await readJson(res);
      if (!res.ok) throw new Error((data.error as string) ?? 'Could not load storage backends');
      setBackends((data.backends as StorageBackend[]) ?? []);
      setCanManage(!!data.canManage);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Could not load storage backends');
    } finally {
      setLoading(false);
    }
  }, []);

  const isFixture = !!fixture;
  useEffect(() => { if (!isFixture) void load(); }, [load, isFixture]);

  const wsName = (id: string | null) => (id ? workspaces.find((w) => w.id === id)?.name ?? 'Workspace' : 'Team default');
  const sorted = [...backends].sort((a, b) =>
    a.workspaceId === null ? -1 : b.workspaceId === null ? 1 : wsName(a.workspaceId).localeCompare(wsName(b.workspaceId)));

  const taken = new Set(backends.map((b) => b.workspaceId ?? ''));
  const scopeOptions: ScopeOption[] = [
    ...(taken.has('') ? [] : [{ value: '', label: 'Team default (every workspace)' }]),
    ...workspaces.filter((w) => !taken.has(w.id)).map((w) => ({ value: w.id, label: w.name })),
  ];

  async function create(form: StorageForm) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch('/api/evidence-backends', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toCreateBody(form)),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data.error as string) ?? 'Could not save the backend');
      const newId = (data.backend as StorageBackend | undefined)?.id;
      setAdding(false);
      setOpenId(newId ?? null);
      setMessage({ ...verificationMessage('Saved', data.verification as Verification | undefined), backendId: newId });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save the backend' });
    } finally {
      setBusy(false);
    }
  }

  async function update(backend: StorageBackend, form: StorageForm) {
    const body = toUpdateBody(form, backend);
    if (Object.keys(body).length === 0) {
      setEditingId(null);
      setMessage({ type: 'success', text: 'Nothing changed.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/evidence-backends/${backend.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data.error as string) ?? 'Could not save the backend');
      setEditingId(null);
      setMessage({ ...verificationMessage('Saved', data.verification as Verification | undefined), backendId: backend.id });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Could not save the backend', backendId: backend.id });
    } finally {
      setBusy(false);
    }
  }

  async function verify(backend: StorageBackend) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/evidence-backends/${backend.id}/verify`, { method: 'POST' });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data.error as string) ?? 'Verify failed');
      const v = data as unknown as Verification;
      const warn = v.warnings?.length ? ` ${v.warnings.join(' ')}` : '';
      setMessage(v.status === 'ok'
        ? { type: 'success', text: `Verified: buildd wrote, read back and deleted a check object.${warn}`, backendId: backend.id }
        : { type: 'error', text: `The check failed: ${v.error ?? 'unknown error'}${warn}`, backendId: backend.id });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Verify failed', backendId: backend.id });
    } finally {
      setBusy(false);
    }
  }

  async function remove(backend: StorageBackend) {
    const scope = wsName(backend.workspaceId);
    if (!(await confirm({
      title: `Remove the ${backend.workspaceId ? `${scope} backend` : 'team default backend'}?`,
      message: backend.workspaceId
        ? 'New evidence for this workspace goes to the team default instead. Objects already in the bucket stay there; buildd keeps its pointers but can no longer read them.'
        : 'New evidence goes to buildd\'s managed bucket instead. Objects already in your bucket stay there; buildd keeps its pointers but can no longer read them.',
      confirmLabel: 'Remove',
      variant: 'danger',
    }))) return;
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/evidence-backends/${backend.id}`, { method: 'DELETE' });
      const data = await readJson(res);
      if (!res.ok) throw new Error((data.error as string) ?? 'Remove failed');
      setOpenId(null);
      setEditingId(null);
      setMessage({ type: 'success', text: 'Removed.' });
      await load();
    } catch (err) {
      setMessage({ type: 'error', text: err instanceof Error ? err.message : 'Remove failed' });
    } finally {
      setBusy(false);
    }
  }

  const addButton = canManage && !adding && scopeOptions.length > 0 ? (
    <button type="button" className="btn btn-accent" data-testid="storage-add"
      onClick={() => { setAdding(true); setMessage(null); }}>
      Add backend
    </button>
  ) : undefined;

  return (
    <>
      <SettingsSection title="Backends" bare action={addButton}>
        <div data-testid="storage-backends" className="card divide-y divide-border-default p-0">
          {loading ? (
            <div className="px-4 py-4 text-sm text-text-muted">Loading…</div>
          ) : loadError ? (
            <div className="px-4 py-4 text-sm text-status-error">{loadError}</div>
          ) : sorted.length === 0 ? (
            <div className="px-4 py-4 space-y-1" data-testid="storage-empty">
              <div className="font-mono text-[13px] font-semibold text-text-primary">buildd managed</div>
              <p className="text-xs text-text-secondary">
                No bucket of your own yet. Evidence goes to buildd&apos;s managed bucket and is kept 30 days.
                {canManage ? ' Add a backend to keep it in a bucket your team controls.' : ''}
              </p>
            </div>
          ) : sorted.map((b) => (
            <BackendRow
              key={b.id}
              backend={b}
              scope={wsName(b.workspaceId)}
              open={openId === b.id}
              onToggle={() => setOpenId(openId === b.id ? null : b.id)}
              editing={editingId === b.id}
              canManage={canManage}
              busy={busy}
              onVerify={() => verify(b)}
              onEdit={() => { setEditingId(b.id); setMessage(null); }}
              onCancelEdit={() => setEditingId(null)}
              onSave={(form) => update(b, form)}
              onRemove={() => remove(b)}
              message={message?.backendId === b.id ? message : null}
            />
          ))}
        </div>
        {message && !(message.backendId && message.backendId === openId && backends.some((b) => b.id === openId)) && (
          <div className="mt-3"><MessageLine message={message} /></div>
        )}
      </SettingsSection>

      {adding && (
        <SettingsSection title="Add a backend">
          <BackendForm
            mode="create"
            scopeOptions={scopeOptions}
            busy={busy}
            onSubmit={create}
            onCancel={() => setAdding(false)}
          />
        </SettingsSection>
      )}
      {confirmDialog}
    </>
  );
}

function BackendRow({
  backend: b, scope, open, onToggle, editing, canManage, busy, onVerify, onEdit, onCancelEdit, onSave, onRemove, message,
}: {
  backend: StorageBackend;
  scope: string;
  open: boolean;
  onToggle: () => void;
  editing: boolean;
  canManage: boolean;
  busy: boolean;
  onVerify: () => void;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (form: StorageForm) => void;
  onRemove: () => void;
  message: Message | null;
}) {
  const chip = statusChip(b);
  const managed = b.provider === 'buildd_default';
  const location = managed ? `buildd managed · ${b.prefix}/` : `${PROVIDER_LABELS[b.provider]} · ${b.bucket}/${b.prefix}/`;
  const snippet = lifecycleSnippet(b);

  return (
    <ConnectionRow
      testId={`storage-row-${b.id}`}
      title={scope}
      chip={<StatusChip tone={chip.tone}>{chip.label}</StatusChip>}
      meta={location}
      open={open}
      onToggle={onToggle}
    >
      {editing ? (
        <div className="space-y-3">
          <BackendForm mode="edit" backend={b} busy={busy} onSubmit={onSave} onCancel={onCancelEdit} />
          {message && <MessageLine message={message} />}
        </div>
      ) : (
        <div className="space-y-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs font-mono" data-testid="storage-details">
            <dt className="text-text-muted">Provider</dt>
            <dd className="text-text-primary">{PROVIDER_LABELS[b.provider]}</dd>
            {!managed && (
              <>
                <dt className="text-text-muted">Bucket</dt>
                <dd className="text-text-primary break-all">{b.bucket}</dd>
                {b.endpoint && (
                  <>
                    <dt className="text-text-muted">Endpoint</dt>
                    <dd className="text-text-primary break-all">{b.endpoint}</dd>
                  </>
                )}
                <dt className="text-text-muted">Region</dt>
                <dd className="text-text-primary">{b.region ?? 'default'}</dd>
              </>
            )}
            <dt className="text-text-muted">Prefix</dt>
            <dd className="text-text-primary break-all">{b.prefix}/</dd>
            {!managed && (
              <>
                <dt className="text-text-muted">Encryption</dt>
                <dd className="text-text-primary break-all">{SSE_LABELS[b.sse]}{b.kmsKeyId ? ` · ${b.kmsKeyId}` : ''}</dd>
              </>
            )}
            <dt className="text-text-muted">Kept for</dt>
            <dd className="text-text-primary">{b.retentionDays} days</dd>
            <dt className="text-text-muted">Per task</dt>
            <dd className="text-text-primary">up to {formatBytes(b.maxBytesPerTask)}</dd>
            {!managed && (
              <>
                <dt className="text-text-muted">Credential</dt>
                <dd className="text-text-primary" data-testid="storage-credential-flag">{b.hasCredential ? 'set' : 'not set'}</dd>
              </>
            )}
            <dt className="text-text-muted">Checked</dt>
            <dd className="text-text-primary">{when(b.lastVerifiedAt)}</dd>
          </dl>

          {b.lastError && b.status !== 'ok' && (
            <p className="notice notice-err text-xs break-words" data-testid="storage-last-error">
              Last error: {b.lastError}
            </p>
          )}

          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={onVerify} disabled={busy}
                className={`btn ${b.status === 'ok' ? '' : 'btn-primary'}`} data-testid="storage-verify">
                {busy ? 'Working…' : 'Verify now'}
              </button>
              <button type="button" onClick={onEdit} disabled={busy} className="btn" data-testid="storage-edit">Edit</button>
              <button type="button" onClick={onRemove} disabled={busy} className="btn btn-danger" data-testid="storage-remove">
                Remove
              </button>
            </div>
          )}
          {message && <MessageLine message={rowMessage(message, b)} />}

          {snippet && (
            <div className="space-y-2 border-t border-border-default pt-4" data-testid="storage-lifecycle">
              <div className="text-sm font-medium text-text-primary">Lifecycle rule</div>
              <p className="text-xs text-text-secondary">
                buildd deletes evidence after {b.retentionDays} days. Add this rule to the bucket as a backstop, so
                objects under <span className="font-mono">{b.prefix}/</span> expire on the same day even if a delete is missed.
              </p>
              <SnippetBlock label="lifecycle.json" text={snippet.config} wrap={false} />
              <SnippetBlock label="Apply it" text={snippet.command} wrap />
            </div>
          )}
        </div>
      )}
    </ConnectionRow>
  );
}
