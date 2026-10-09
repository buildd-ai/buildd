'use client';

/**
 * Settings -> Profile -> "Standing rules": the rules chat loads into every one
 * of your turns (knowledge-base: buildd/design/memory-done-right.md, "Chat"). Saved from a card
 * in the thread ("Remember this") or added here; edited and removed here.
 * Yours only: nobody else on the team sees them. Mobile-first: one rule per
 * hairline row, the rule in Newsreader, its scope in mono under it. One add
 * control: the section action, or the inline link in the empty sentence.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ChatDirectiveDTO, ListChatDirectivesResponse } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Section from '@/components/ui/Section';

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
        placeholder="Never force-push to dev."
        className="block w-full resize-y border border-border-strong bg-surface-1 px-3 py-2 font-voice text-lede leading-[1.4] text-text-primary placeholder:text-text-muted"
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
      <p className="font-mono text-chip text-text-muted">{trimmed.length} / {MAX}</p>
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

  const startAdding = () => { setAdding(true); setEditing(null); };
  const empty = !!data && rules.length === 0;

  return (
    <div id="standing-rules" className="scroll-mt-20" data-testid="standing-rules">
      <Section
        title="Standing rules"
        action={!adding && !empty ? (
          <button type="button" onClick={startAdding} className="btn h-11 md:h-8" data-testid="standing-rules-add">
            Add a rule
          </button>
        ) : undefined}
      >
        <p className="mb-2 text-sm text-text-muted">
          Chat follows these in every reply. Only you can edit them. Tasks chat files carry the matching rules, visible to the workspace.
        </p>
        {adding && (
          <div className="border-t border-border-default py-3">
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
        {empty && !adding && (
          <p className="text-sm text-text-muted">
            <span data-testid="standing-rules-empty">No rules.</span>{' '}
            <button type="button" onClick={startAdding} className="min-h-11 md:min-h-0 font-medium text-text-primary underline underline-offset-2" data-testid="standing-rules-add">
              Add a rule
            </button>
          </p>
        )}
        {!data && !error && <p className="font-mono text-meta text-text-muted">Loading…</p>}
        {rules.length > 0 && (
          <ul className="divide-y divide-border-default border-y border-border-default">
            {rules.map(d => (
              <li key={d.id} data-testid="standing-rule" className="py-3">
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
                      <p className="font-voice text-lede leading-[1.4] text-text-primary [overflow-wrap:anywhere]">{d.text}</p>
                      <p data-testid="standing-rule-scope" className="mt-1 font-mono text-meta text-text-muted">{scopeLabel(d)}</p>
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
        )}
        {error && <p role="alert" className="mt-2 text-sm text-status-error">{error}</p>}
      </Section>
    </div>
  );
}
