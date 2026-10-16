'use client';

/**
 * Settings → Connected apps → Team apps: the outside tools the team's agents
 * can call, one hairline row each. A catalog entry and the team's connector on
 * the same host are one row (lib/team-apps-view.ts); a custom connector is a
 * row of its own.
 *
 * The row says what is true and offers its one next step: Connect, Reconnect
 * or Add key for an admin, Request for a member, else the state in words
 * (Connected, Not available, Blocked by your team). Everything an admin can
 * change about an app (which workspaces get it, the team setting, sharing,
 * disconnect, remove) is in the row's details. A member opens the same
 * details read-only. The API refuses the same writes to a member, so nothing
 * here is the permission check; every control posts and shows the answer.
 *
 * A provider that won't let buildd connect reads "Not available" with no
 * step and no reason: why is operator detail (server log, platform catalog).
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import ConfirmDialog from '@/components/ConfirmDialog';
import { ConnectorIcon } from '@/components/ConnectorIcon';
import Disclosure from '@/components/ui/Disclosure';
import Notice from '@/components/ui/Notice';
import Section from '@/components/ui/Section';
import { Select } from '@/components/ui/Select';
import type { CatalogPolicy, CustomerCatalogEntry } from '@/lib/connector-catalog';
import {
  POLICY_CHOICES,
  buildTeamApps,
  isBlocked,
  stepErrorText,
  teamAppState,
  workspaceSummary,
  type TeamApp,
  type TeamAppState,
  type TeamConnector,
} from '@/lib/team-apps-view';
import AddConnectionModal from './AddConnectionModal';
import AddTeamEntryForm from './AddTeamEntryForm';
import SharingDialog from './SharingDialog';

export interface TeamAppsData {
  canManage: boolean;
  entries: CustomerCatalogEntry[];
  connectors: TeamConnector[];
  /** connector id → the team workspaces it is turned on in. */
  enabled: Record<string, string[]>;
}

interface Workspace { id: string; name: string }

/** Plain words for the codes the OAuth callback redirects with. */
const OAUTH_ERROR_TEXT: Record<string, string> = {
  blocked_by_policy: 'Your team has blocked this app, so it can’t be connected.',
  forbidden: 'Only a team admin can connect a team app.',
  session_mismatch: 'You signed in as someone else during the connection. Start Connect again.',
  token_exchange_failed: 'The app didn’t accept the sign-in. Try Connect again.',
  invalid_token_audience: 'The app’s sign-in was for a different server. Check its address.',
};

const POLICY_FACT: Partial<Record<CatalogPolicy, string>> = {
  preinstalled: 'Added to every workspace. Used only when the agent does.',
  blocked: 'Agents can’t use it. Its sign-in is kept.',
};

const TONE_CLASS: Record<TeamAppState['tone'], string> = {
  ok: 'text-status-success',
  act: 'text-status-warning',
  muted: 'text-text-muted',
};

async function loadData(teamId: string | null, workspaces: Workspace[]): Promise<TeamAppsData> {
  const [catRes, connRes, ...wsRes] = await Promise.all([
    fetch('/api/connectors/catalog'),
    fetch(teamId ? `/api/connectors?teamId=${encodeURIComponent(teamId)}` : '/api/connectors'),
    ...workspaces.map(ws => fetch(`/api/workspaces/${ws.id}/connectors`).catch(() => null)),
  ]);
  const cat = catRes.ok ? await catRes.json() as { canManage?: boolean; entries?: CustomerCatalogEntry[] } : {};
  const conn = connRes.ok ? await connRes.json() as { connectors?: TeamConnector[] } : {};
  const enabled: Record<string, string[]> = {};
  for (let i = 0; i < workspaces.length; i++) {
    const res = wsRes[i];
    if (!res?.ok) continue;
    const data = await res.json() as { connectors?: { id: string }[] };
    for (const c of data.connectors ?? []) (enabled[c.id] ??= []).push(workspaces[i].id);
  }
  return { canManage: !!cat.canManage, entries: cat.entries ?? [], connectors: conn.connectors ?? [], enabled };
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return res.json().catch(() => ({}));
}

export default function TeamAppsSection({
  teamId = null,
  workspaces,
  connectedId,
  errorMsg,
  initial,
  initiallyOpen = null,
}: {
  teamId?: string | null;
  /** The team's workspaces: where an app can be turned on. */
  workspaces: Workspace[];
  /** `?connected=` / `?error=` from the OAuth callback. */
  connectedId?: string;
  errorMsg?: string;
  /** Fixture only: render this data and load nothing. */
  initial?: TeamAppsData;
  /** Fixture only: a row to show open. */
  initiallyOpen?: string | null;
}) {
  const [data, setData] = useState<TeamAppsData | null>(initial ?? null);
  const [open, setOpen] = useState<string | null>(initiallyOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(() =>
    connectedId ? { tone: 'ok', text: 'Connected.' }
      : errorMsg ? { tone: 'err', text: OAUTH_ERROR_TEXT[errorMsg] ?? 'The sign-in didn’t finish. Try Connect again.' }
        : null,
  );
  const [adding, setAdding] = useState(false);
  const [sharing, setSharing] = useState<TeamConnector | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'disconnect' | 'remove'; connector: TeamConnector } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const keyRefs = useRef(new Map<string, HTMLInputElement>());

  const reload = useCallback(async () => {
    if (initial) return;
    try { setData(await loadData(teamId, workspaces)); } catch { setData(d => d ?? { canManage: false, entries: [], connectors: [], enabled: {} }); }
  }, [initial, teamId, workspaces]);

  useEffect(() => { void reload(); }, [reload]);

  if (!data) return null;
  const { canManage } = data;
  const apps = buildTeamApps(data.entries, data.connectors);

  async function connect(app: TeamApp, connectorId: string) {
    const res = await fetch(`/api/connectors/${connectorId}/connect`, { method: 'POST' });
    const body = await json(res);
    if (res.ok && typeof body.authorizationUrl === 'string') {
      window.location.href = body.authorizationUrl;
      return;
    }
    setMessage({ tone: 'err', text: stepErrorText(app.name, body) });
  }

  async function runStep(app: TeamApp, state: TeamAppState) {
    const action = state.action;
    if (!action) return;
    if (action.kind === 'set_key') {
      setOpen(app.key);
      setTimeout(() => keyRefs.current.get(app.key)?.focus(), 0);
      return;
    }
    setBusy(app.key);
    setMessage(null);
    try {
      if (action.kind === 'request') {
        const res = await fetch('/api/connectors/catalog/request', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slug: app.entry?.slug }),
        });
        const body = await json(res);
        if (res.ok) {
          setRequested(prev => new Set(prev).add(app.key));
          setMessage({ tone: 'ok', text: `Asked your team’s admins for ${app.name}.` });
        } else {
          setMessage({ tone: 'err', text: typeof body.message === 'string' ? body.message : `Couldn’t send the request for ${app.name}.` });
        }
        return;
      }
      if (action.kind === 'install') {
        const entry = app.entry!;
        const res = await fetch('/api/connectors', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(entry.authMode === 'none' ? { name: entry.name, url: entry.url, authMode: 'none' } : { name: entry.name, url: entry.url }),
        });
        const body = await json(res) as { connector?: { id: string }; message?: string };
        if (!res.ok || !body.connector) {
          setMessage({ tone: 'err', text: stepErrorText(app.name, body) });
          return;
        }
        await reload();
        if (entry.authMode === 'oauth') await connect(app, body.connector.id);
        else setMessage({ tone: 'ok', text: `${app.name} added.` });
        return;
      }
      if (app.connector) await connect(app, app.connector.id);
    } catch {
      setMessage({ tone: 'err', text: `Couldn’t reach buildd. Try again.` });
    } finally {
      setBusy(null);
    }
  }

  async function write(key: string, url: string, init: RequestInit, ok: string | null, fail: string, after: () => void | Promise<void> = reload) {
    setBusy(key);
    setMessage(null);
    try {
      const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json' } });
      const body = await json(res);
      if (!res.ok) {
        setMessage({ tone: 'err', text: typeof body.message === 'string' ? body.message : fail });
        return false;
      }
      if (ok) setMessage({ tone: 'ok', text: ok });
      await after();
      return true;
    } catch {
      setMessage({ tone: 'err', text: fail });
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function confirmAction() {
    if (!confirm) return;
    const { kind, connector } = confirm;
    setConfirmBusy(true);
    const done = kind === 'disconnect'
      ? await write(connector.id, `/api/connectors/${connector.id}/disconnect`, { method: 'POST' }, `${connector.name} disconnected.`, `Couldn’t disconnect ${connector.name}.`)
      : await write(connector.id, `/api/connectors/${connector.id}`, { method: 'DELETE' }, `${connector.name} removed.`, `Couldn’t remove ${connector.name}.`);
    setConfirmBusy(false);
    if (done) setConfirm(null);
  }

  return (
    <Section
      title="Team apps"
      count={apps.length || undefined}
      action={canManage ? (
        <button type="button" className="btn btn-sm h-11 md:h-8" onClick={() => setAdding(true)} data-testid="team-apps-add">
          Add custom app
        </button>
      ) : undefined}
    >
      {!canManage && (
        <p className="mb-3 text-body text-text-secondary" data-testid="team-apps-member-note">
          Team admins connect these for everyone. Request one your work needs.
        </p>
      )}
      {message && (
        <Notice tone={message.tone} className="mb-3" data-testid="team-apps-message">{message.text}</Notice>
      )}

      {apps.length === 0 ? (
        <p className="text-body text-text-muted" data-testid="team-apps-empty">No apps.</p>
      ) : (
        <ul className="divide-y divide-border-default border-y border-border-default" data-testid="team-apps">
          {apps.map(app => {
            let state = teamAppState(app, canManage);
            if (state.action?.kind === 'request' && requested.has(app.key)) state = { ...state, action: null, label: 'Requested' };
            return (
              <TeamAppRow
                key={app.key}
                app={app}
                state={state}
                canManage={canManage}
                workspaces={workspaces}
                enabled={app.connector ? data.enabled[app.connector.id] ?? [] : []}
                open={open === app.key}
                busy={busy}
                onToggle={() => setOpen(open === app.key ? null : app.key)}
                onStep={() => void runStep(app, state)}
                keyRef={el => { if (el) keyRefs.current.set(app.key, el); else keyRefs.current.delete(app.key); }}
                onSaveKey={value => write(app.key, `/api/connectors/${app.connector!.id}`, { method: 'PATCH', body: JSON.stringify({ headerValue: value }) }, `Key saved for ${app.name}.`, `Couldn’t save the key for ${app.name}.`)}
                onWorkspace={(wsId, on) => {
                  const id = app.connector!.id;
                  // The workspace's answer is the new state: no full reload per checkbox.
                  return write(`${app.key}:${wsId}`, `/api/workspaces/${wsId}/connectors`, { method: 'PATCH', body: JSON.stringify({ connectorId: id, enabled: on }) }, null, `Couldn’t change ${app.name} there.`, () => {
                    setData(d => {
                      if (!d) return d;
                      const rest = (d.enabled[id] ?? []).filter(w => w !== wsId);
                      return { ...d, enabled: { ...d.enabled, [id]: on ? [...rest, wsId] : rest } };
                    });
                  });
                }}
                onPolicy={policy => write(app.key, '/api/connectors/catalog/policy', { method: 'PUT', body: JSON.stringify({ slug: app.entry!.slug, policy }) }, null, `Couldn’t change ${app.name}.`)}
                onRemoveEntry={() => write(app.key, `/api/connectors/catalog/${app.entry!.id}`, { method: 'DELETE' }, `${app.name} removed from your catalog.`, `Couldn’t remove ${app.name}.`)}
                onShare={() => app.connector && setSharing(app.connector)}
                onDisconnect={() => app.connector && setConfirm({ kind: 'disconnect', connector: app.connector })}
                onRemove={() => app.connector && setConfirm({ kind: 'remove', connector: app.connector })}
              />
            );
          })}
        </ul>
      )}

      {canManage && (
        <Disclosure summary="Add an internal app to your team’s catalog" className="mt-3">
          <div className="pt-2">
            <AddTeamEntryForm onAdded={async () => { setMessage({ tone: 'ok', text: 'Added to your catalog.' }); await reload(); }} />
          </div>
        </Disclosure>
      )}

      {canManage && adding && (
        <AddConnectionModal
          startWith="form"
          onClose={() => setAdding(false)}
          existingUrls={data.connectors.filter(c => !c.shared).map(c => c.url)}
          onAdded={async (c) => {
            setAdding(false);
            await reload();
            if (c.authMode === 'oauth') await connect({ key: c.id, name: c.name, description: null, iconUrl: null, url: c.url, entry: null, connector: null }, c.id);
          }}
        />
      )}

      {sharing && (
        <SharingDialog
          connector={sharing}
          onClose={() => setSharing(null)}
          onTransferred={async (text) => { setSharing(null); setMessage({ tone: 'ok', text }); await reload(); }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.kind === 'disconnect' ? `Disconnect ${confirm.connector.name}?` : `Remove ${confirm?.connector.name ?? 'this app'}?`}
        message={confirm?.kind === 'disconnect'
          ? 'Agents lose it until an admin connects it again.'
          : 'Removes it and its sign-in from your team and every workspace.'}
        confirmLabel={confirm?.kind === 'disconnect' ? 'Disconnect' : 'Remove'}
        variant={confirm?.kind === 'disconnect' ? 'warning' : 'danger'}
        loading={confirmBusy}
        onConfirm={() => void confirmAction()}
        onCancel={() => setConfirm(null)}
      />
    </Section>
  );
}

function TeamAppRow({
  app, state, canManage, workspaces, enabled, open, busy,
  onToggle, onStep, keyRef, onSaveKey, onWorkspace, onPolicy, onRemoveEntry, onShare, onDisconnect, onRemove,
}: {
  app: TeamApp;
  state: TeamAppState;
  canManage: boolean;
  workspaces: Workspace[];
  enabled: string[];
  open: boolean;
  busy: string | null;
  onToggle: () => void;
  onStep: () => void;
  keyRef: (el: HTMLInputElement | null) => void;
  onSaveKey: (value: string) => Promise<boolean>;
  onWorkspace: (workspaceId: string, on: boolean) => Promise<boolean>;
  onPolicy: (policy: CatalogPolicy) => Promise<boolean>;
  onRemoveEntry: () => Promise<boolean>;
  onShare: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
}) {
  const panelId = useId();
  const [key, setKey] = useState('');
  const c = app.connector;
  const own = canManage && !!c && !c.shared;
  const blocked = isBlocked(app);
  // Nothing to open for an app no one here can use or change.
  const hasDetails = !(app.entry?.unavailable && !c) && (!!c || canManage);
  const meta = [state.action && state.tone === 'act' ? state.label : null, c?.shared ? `From ${c.ownerTeamName || 'another team'}` : null, app.description]
    .filter(Boolean).join(' · ');
  const on = new Set(enabled);

  const heading = (
    <>
      <ConnectorIcon name={app.name} iconUrl={app.iconUrl} size={20} />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-text-primary">{app.name}</span>
        {meta && <span className="mt-0.5 block line-clamp-2 text-meta text-text-muted">{meta}</span>}
      </span>
    </>
  );

  return (
    <li data-testid={`team-app-${app.key}`} data-state={state.label}>
      <div className="flex min-h-14 items-center gap-2">
        {hasDetails ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={panelId}
            className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5 text-left"
            data-testid={`team-app-toggle-${app.key}`}
          >
            {heading}
            <span aria-hidden="true" className={`shrink-0 text-meta text-text-muted transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
          </button>
        ) : (
          <div className="flex min-h-14 min-w-0 flex-1 items-center gap-3 py-2.5">{heading}</div>
        )}
        <div className="shrink-0">
          {state.action ? (
            <button
              type="button"
              className="btn btn-sm h-11 md:h-8"
              disabled={busy === app.key}
              onClick={onStep}
              aria-label={`${state.action.label} ${app.name}`}
              data-testid={`team-app-step-${app.key}`}
            >
              {busy === app.key ? 'Working…' : state.action.label}
            </button>
          ) : (
            <span className={`text-meta ${TONE_CLASS[state.tone]}`} data-testid={`team-app-state-${app.key}`}>{state.label}</span>
          )}
        </div>
      </div>

      <div id={panelId} hidden={!open}>
        {open && hasDetails && (
          <div className="space-y-4 pb-4 pl-8" data-testid={`team-app-details-${app.key}`}>
            {c?.shared && (
              <p className="text-body text-text-secondary">Shared by {c.ownerTeamName || 'another team'}, which manages its sign-in.</p>
            )}

            {c && !blocked && workspaces.length > 0 && (
              <fieldset className="space-y-1">
                <legend className="text-body font-medium text-text-primary">
                  Workspaces <span className="font-normal text-text-muted">· {workspaceSummary(enabled.length, workspaces.length)}</span>
                </legend>
                {canManage ? (
                  <ul className="divide-y divide-[var(--line-soft)]">
                    {workspaces.map(ws => (
                      <li key={ws.id}>
                        <label className="flex min-h-11 cursor-pointer items-center gap-3 md:min-h-9">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--accent)]"
                            checked={on.has(ws.id)}
                            disabled={busy === `${app.key}:${ws.id}`}
                            onChange={e => void onWorkspace(ws.id, e.target.checked)}
                            data-testid={`team-app-ws-${app.key}-${ws.id}`}
                          />
                          <span className="min-w-0 break-words text-body text-text-primary">{ws.name}</span>
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : enabled.length > 0 && enabled.length < workspaces.length ? (
                  <p className="text-body text-text-secondary">{workspaces.filter(w => on.has(w.id)).map(w => w.name).join(', ')}</p>
                ) : null}
              </fieldset>
            )}

            {own && c!.authMode === 'header' && (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={async e => { e.preventDefault(); if (key.trim() && await onSaveKey(key.trim())) setKey(''); }}
              >
                <label className="min-w-0 flex-1">
                  <span className="field-label">API key</span>
                  <input
                    ref={keyRef}
                    type="password"
                    value={key}
                    onChange={e => setKey(e.target.value)}
                    className="w-full border border-border-default bg-surface-3 px-3 py-2 text-base text-text-primary md:text-sm"
                    autoComplete="off"
                  />
                </label>
                <button type="submit" className="btn h-11 md:h-9" disabled={!key.trim() || busy === app.key}>Save key</button>
              </form>
            )}

            {canManage && app.entry && (
              <div className="space-y-1">
                <span className="field-label">Team setting</span>
                <Select
                  aria-label={`${app.name} team setting`}
                  size="sm"
                  value={app.entry.policy}
                  disabled={busy === app.key}
                  onChange={v => { if (v !== app.entry!.policy) void onPolicy(v as CatalogPolicy); }}
                  options={POLICY_CHOICES}
                  testId={`team-app-policy-${app.key}`}
                  className="max-w-[16rem]"
                />
                {POLICY_FACT[app.entry.policy] && <p className="text-meta text-text-muted">{POLICY_FACT[app.entry.policy]}</p>}
              </div>
            )}

            <p className="break-all font-mono text-meta text-text-muted">{app.url}</p>

            {canManage && (own || app.entry?.source === 'team') && (
              <div className="flex flex-wrap gap-2 border-t border-[var(--line-soft)] pt-3">
                {own && <button type="button" className="btn btn-sm h-11 md:h-8" onClick={onShare}>Share with a team</button>}
                {own && c!.authMode !== 'none' && (c!.status === 'connected' || c!.status === 'expired') && (
                  <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" onClick={onDisconnect}>Disconnect</button>
                )}
                {own && <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" onClick={onRemove}>Remove</button>}
                {app.entry?.source === 'team' && !c && (
                  <button type="button" className="btn btn-sm btn-quiet h-11 md:h-8" disabled={busy === app.key} onClick={() => void onRemoveEntry()}>Remove from catalog</button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </li>
  );
}
