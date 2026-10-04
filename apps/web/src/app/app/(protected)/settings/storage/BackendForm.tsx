'use client';

import { useState, type ReactNode } from 'react';
import { Select } from '@/components/ui/Select';
import {
  PROVIDER_LABELS,
  SSE_LABELS,
  emptyForm,
  formFromBackend,
  validateForm,
  withProvider,
  type EvidenceProvider,
  type EvidenceSse,
  type FormErrors,
  type StorageBackend,
  type StorageForm,
} from './_lib/storage-form';

export interface ScopeOption {
  value: string;
  label: string;
}

const PROVIDERS: EvidenceProvider[] = ['s3', 'r2', 's3_compatible', 'buildd_default'];
const SSE_MODES: EvidenceSse[] = ['none', 'AES256', 'aws:kms'];

const ENDPOINT_HINT: Partial<Record<EvidenceProvider, string>> = {
  s3: 'Optional. Leave blank for AWS.',
  r2: 'https://<account-id>.r2.cloudflarestorage.com',
  s3_compatible: 'Your service\'s https endpoint.',
};

function Field({ label, error, hint, children, htmlFor }: {
  label: string; error?: string; hint?: ReactNode; children: ReactNode; htmlFor?: string;
}) {
  return (
    <div>
      <label className="field-label" htmlFor={htmlFor}>{label}</label>
      {children}
      {error
        ? <p className="mt-1 text-xs text-status-error" data-testid={`storage-error-${htmlFor}`}>{error}</p>
        : hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
    </div>
  );
}

const inputCls = 'w-full h-10 px-3 bg-surface text-sm font-mono';

/**
 * Add or edit one evidence backend. On edit, provider and scope are fixed
 * (the API refuses to change them) and the credential fields start blank:
 * the form is built field by field from the DTO in `formFromBackend`, so a
 * stored secret has no way to reach an input. "Credential set" comes from
 * `hasCredential` alone.
 */
export default function BackendForm({
  mode, backend, scopeOptions = [], busy, onSubmit, onCancel,
}: {
  mode: 'create' | 'edit';
  backend?: StorageBackend;
  /** Create only: where the backend applies. '' = team default. */
  scopeOptions?: ScopeOption[];
  busy: boolean;
  onSubmit: (form: StorageForm) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<StorageForm>(() => {
    if (backend) return formFromBackend(backend);
    return { ...emptyForm(), workspaceId: scopeOptions[0]?.value ?? '' };
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [tried, setTried] = useState(false);

  const set = <K extends keyof StorageForm>(key: K, value: StorageForm[K]) => {
    const next = { ...form, [key]: value };
    setForm(next);
    if (tried) setErrors(validateForm(next, mode));
  };

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setTried(true);
    const found = validateForm(form, mode);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    void onSubmit(form);
  }

  const managed = form.provider === 'buildd_default';
  const idp = mode === 'edit' ? `edit-${backend?.id ?? ''}` : 'new';
  const fid = (k: string) => `storage-${idp}-${k}`;

  return (
    <form onSubmit={submit} noValidate className="space-y-4" data-testid={`storage-form-${mode}`}>
      {mode === 'create' && (
        <div className="grid gap-4 md:grid-cols-2">
          {scopeOptions.length > 1 && (
            <Field label="Applies to" htmlFor={fid('scope')}>
              <Select
                id={fid('scope')}
                aria-label="Applies to"
                value={form.workspaceId}
                onChange={(v) => set('workspaceId', v)}
                options={scopeOptions}
              />
            </Field>
          )}
          <Field label="Provider" htmlFor={fid('provider')}>
            <Select<EvidenceProvider>
              id={fid('provider')}
              aria-label="Provider"
              value={form.provider}
              onChange={(p) => { setForm(withProvider(form, p)); if (tried) setErrors(validateForm(withProvider(form, p), mode)); }}
              options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABELS[p] }))}
            />
          </Field>
        </div>
      )}

      {managed ? (
        <p className="text-xs text-text-secondary">
          Kept 30 days.
        </p>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Bucket" htmlFor={fid('bucket')} error={errors.bucket}>
              <input id={fid('bucket')} value={form.bucket} onChange={(e) => set('bucket', e.target.value)}
                autoComplete="off" spellCheck={false} placeholder="my-team-evidence" className={inputCls} />
            </Field>
            <Field label="Region" htmlFor={fid('region')} error={errors.region}
              hint={form.provider === 's3' ? undefined : 'Optional.'}>
              <input id={fid('region')} value={form.region} onChange={(e) => set('region', e.target.value)}
                autoComplete="off" spellCheck={false} placeholder={form.provider === 'r2' ? 'auto' : 'us-east-1'} className={inputCls} />
            </Field>
          </div>
          <Field label="Endpoint" htmlFor={fid('endpoint')} error={errors.endpoint} hint={ENDPOINT_HINT[form.provider]}>
            <input id={fid('endpoint')} type="url" value={form.endpoint} onChange={(e) => set('endpoint', e.target.value)}
              autoComplete="off" spellCheck={false} placeholder="https://" className={inputCls} />
          </Field>
        </>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Field label="Key prefix" htmlFor={fid('prefix')} error={errors.prefix} hint="One path segment.">
          <input id={fid('prefix')} value={form.prefix} onChange={(e) => set('prefix', e.target.value)}
            autoComplete="off" spellCheck={false} className={inputCls} />
        </Field>
        {!managed && (
          <Field label="Keep for (days)" htmlFor={fid('retentionDays')} error={errors.retentionDays}>
            <input id={fid('retentionDays')} inputMode="numeric" value={form.retentionDays}
              onChange={(e) => set('retentionDays', e.target.value)} autoComplete="off" className={inputCls} />
          </Field>
        )}
      </div>

      {!managed && (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Encryption" htmlFor={fid('sse')}>
              <Select<EvidenceSse>
                id={fid('sse')}
                aria-label="Encryption"
                value={form.sse}
                onChange={(v) => set('sse', v)}
                options={SSE_MODES.map((m) => ({ value: m, label: SSE_LABELS[m] }))}
              />
            </Field>
            {form.sse === 'aws:kms' && (
              <Field label="KMS key" htmlFor={fid('kmsKeyId')} error={errors.kmsKeyId}>
                <input id={fid('kmsKeyId')} value={form.kmsKeyId} onChange={(e) => set('kmsKeyId', e.target.value)}
                  autoComplete="off" spellCheck={false} placeholder="Key id or ARN" className={inputCls} />
              </Field>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input type="checkbox" checked={form.forcePathStyle} onChange={(e) => set('forcePathStyle', e.target.checked)} />
            Path-style URLs
          </label>

          <fieldset className="space-y-3 border-t border-border-default pt-4">
            <legend className="sr-only">Credential</legend>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-text-primary">Access key</span>
              {mode === 'edit' && (
                <span data-testid="storage-credential-state" className="font-mono text-[11px] text-text-muted">
                  {backend?.hasCredential ? 'Credential set. Leave blank to keep it.' : 'No credential stored.'}
                </span>
              )}
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Access key ID" htmlFor={fid('accessKeyId')} error={errors.accessKeyId}>
                <input id={fid('accessKeyId')} value={form.accessKeyId} onChange={(e) => set('accessKeyId', e.target.value)}
                  autoComplete="off" spellCheck={false} data-credential-input className={inputCls}
                  placeholder={mode === 'edit' ? 'Unchanged' : ''} />
              </Field>
              <Field label="Secret access key" htmlFor={fid('secretAccessKey')} error={errors.secretAccessKey}>
                <input id={fid('secretAccessKey')} type="password" value={form.secretAccessKey}
                  onChange={(e) => set('secretAccessKey', e.target.value)} autoComplete="new-password"
                  data-credential-input className={inputCls} placeholder={mode === 'edit' ? 'Unchanged' : ''} />
              </Field>
            </div>
            <Field label="Session token" htmlFor={fid('sessionToken')} hint="Optional, for temporary credentials.">
              <input id={fid('sessionToken')} type="password" value={form.sessionToken}
                onChange={(e) => set('sessionToken', e.target.value)} autoComplete="new-password"
                data-credential-input className={inputCls} />
            </Field>
            <p className="text-xs text-text-muted">
              Needs put, get and delete on the prefix. Encrypted, never sent to runners.
            </p>
          </fieldset>
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy} className="btn btn-primary" data-testid={`storage-submit-${mode}`}>
          {busy ? 'Saving…' : mode === 'create' ? 'Save and verify' : 'Save and re-verify'}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="btn btn-quiet">Cancel</button>
      </div>
    </form>
  );
}
