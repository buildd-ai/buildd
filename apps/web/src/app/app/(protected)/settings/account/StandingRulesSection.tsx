'use client';

/**
 * Settings -> Profile -> "Standing rules": the rules chat loads into every one
 * of your turns (docs/design/memory-done-right.md, "Chat"). Saved from a card
 * in the thread ("Remember this") or added here; edited and removed here.
 * Yours only: nobody else on the team sees them. Square and mobile-first: one
 * rule per row, the rule in Newsreader, its scope in mono under it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChatDirectiveDTO, ListChatDirectivesResponse } from '@buildd/shared';
import { Select } from '@/components/ui/Select';

const EVERYWHERE = '__everywhere__';
const MAX = 280;

async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method,
    credentials: 'include',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof json.message === 'string' ? json.message : typeof json.error === 'string' ? json.error : 'Something went wrong. Try again.');
  return json;
}

function scopeLabel(d: ChatDirectiveDTO): string {
  if (!d.workspaceId) return 'Every chat';
  return d.workspaceName ? `Only ${d.workspaceName}` : 'One workspace you no longer reach';
}

function RuleEditor({
  initialText, initialScope, workspaces, busy, submitLabel, onSubmit, onCancel, testId,
}: {
  initialText: string;
  initialScope: string | null;
  workspaces: ListChatDirectivesResponse['workspaces'];
  busy: boolean;
  submitLabel: string;
  onSubmit: (text: string, workspaceId: string | null) => void;
  onCancel?: () => void;
  testId: string;
}) {
  const [text, setText] = useState(initialText);
  const [scope, setScope] = useState<string>(initialScope ?? EVERYWHERE);
  const options = [{ value: EVERYWHERE, label: 'Every chat' }, ...workspaces.map(w => ({ value: w.id, label: `Only ${w.name}` }))];
  const trimmed = text.trim();
  return (
    <form
      data-testid={testId}
      className="space-y-2.5"
      onSubmit={(e) => { e.preventDefault(); if (trimmed) onSubmit(trimmed, scope === EVERYWHERE ? null : scope); }}
    >
      <textarea
        aria-label="Rule"
        data-testid={`${testId}-text`}
        value={text}
        maxLength={MAX}
        rows={2}
        onChange={e => setText(e.target.value)}
        placeholder="Always open pull requests as drafts."
        className="block w-full resize-y border border-border-strong bg-surface-1 px-3 py-2 font-voice text-[16px] leading-[1.4] text-text-primary placeholder:text-text-muted"
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={scope}
          onChange={setScope}
          options={options}
          aria-label="Where this rule applies"
          sheetTitle="Where this rule applies"
          className="min-w-0 flex-1 sm:flex-none sm:w-60"
          testId={`${testId}-scope`}
        />
        <button type="submit" disabled={busy || !trimmed} data-testid={`${testId}-submit`} className="btn btn-lg btn-primary">{submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} disabled={busy} className="btn btn-lg btn-quiet">Cancel</button>}
      </div>
      <p className="font-mono text-[11px] text-text-muted">{trimmed.length} / {MAX}</p>
    </form>
  );
}

export default function StandingRulesSection() {
  const [data, setData] = useState<ListChatDirectivesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await send('/api/chat/directives', 'GET') as unknown as ListChatDirectivesResponse);
      setError(null);
    } catch {
      setError("Couldn't load your rules.");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setEditing(null);
      setAdding(false);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const rules = data?.directives ?? [];
  const workspaces = data?.workspaces ?? [];

  return (
    <section id="standing-rules" aria-labelledby="standing-rules-h" className="scroll-mt-20" data-testid="standing-rules">
      <div className="mb-3 flex min-h-8 items-center justify-between gap-3">
        <h2 id="standing-rules-h" className="section-label">Standing rules</h2>
        {!adding && (
          <button type="button" onClick={() => { setAdding(true); setEditing(null); }} className="btn btn-lg" data-testid="standing-rules-add">
            Add a rule
          </button>
        )}
      </div>
      <div className="card">
        <p className="border-b border-border-default px-4 py-3 text-xs leading-relaxed text-text-secondary">
          Chat follows these in every reply. Only you see them. Say &ldquo;always&rdquo; or &ldquo;never&rdquo; in chat and tap Remember this to add one there.
        </p>
        {adding && (
          <div className="border-b border-border-default px-4 py-3">
            <RuleEditor
              testId="standing-rule-new"
              initialText=""
              initialScope={null}
              workspaces={workspaces}
              busy={busy}
              submitLabel="Save rule"
              onSubmit={(text, workspaceId) => { void act(() => send('/api/chat/directives', 'POST', { text, workspaceId })); }}
              onCancel={() => setAdding(false)}
            />
          </div>
        )}
        {data && rules.length === 0 && !adding && (
          <p data-testid="standing-rules-empty" className="px-4 py-5 text-sm text-text-secondary">No rules yet.</p>
        )}
        {!data && !error && <p className="px-4 py-5 font-mono text-[12px] text-text-muted">Loading…</p>}
        <ul className="divide-y divide-border-default">
          {rules.map(d => (
            <li key={d.id} data-testid="standing-rule" className="px-4 py-3">
              {editing === d.id ? (
                <RuleEditor
                  testId="standing-rule-edit"
                  initialText={d.text}
                  initialScope={d.workspaceId}
                  workspaces={workspaces}
                  busy={busy}
                  submitLabel="Save"
                  onSubmit={(text, workspaceId) => { void act(() => send(`/api/chat/directives/${d.id}`, 'PATCH', { text, workspaceId })); }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-voice text-[16.5px] leading-[1.4] text-text-primary [overflow-wrap:anywhere]">{d.text}</p>
                    <p data-testid="standing-rule-scope" className="mt-1 font-mono text-[11px] uppercase tracking-[.12em] text-text-secondary">{scopeLabel(d)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button type="button" disabled={busy} onClick={() => { setEditing(d.id); setAdding(false); }} className="btn btn-lg btn-quiet" data-testid="standing-rule-edit-open">
                      Edit
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={`Remove rule: ${d.text}`}
                      onClick={() => { void act(() => send(`/api/chat/directives/${d.id}`, 'DELETE')); }}
                      className="btn btn-lg btn-quiet text-status-error"
                      data-testid="standing-rule-remove"
                    >
                      Remove
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="border-t border-border-default px-4 py-3 text-xs text-status-error">{error}</p>}
      </div>
    </section>
  );
}
