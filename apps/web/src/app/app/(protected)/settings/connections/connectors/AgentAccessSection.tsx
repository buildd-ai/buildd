'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import Disclosure from '@/components/ui/Disclosure';
import { TonePill } from '@/components/ui/StatePill';
import { Select } from '@/components/ui/Select';
import {
  EFFECT_LABEL,
  RISK_LABEL,
  accessAsk,
  accessStatusLine,
  accessWho,
  approveLabel,
  decisionResultText,
  defaultEffectText,
  effectsFor,
  formatLease,
  leaseChoices,
  providerName,
  type AccessEffect,
  type AccessRequestView,
  type AccessRisk,
} from '@/lib/capability-grants-view';

const RISKS: AccessRisk[] = ['read', 'query', 'write', 'admin'];
const DEFAULT = 'default';

interface Rule {
  id: string;
  provider: string;
  risk: AccessRisk;
  workspaceId: string | null;
  roleSlug: string | null;
  environment: string | null;
  resource: string | null;
  effect: AccessEffect;
  maxTtlSeconds: number | null;
}

interface CatalogProvider { slug: string; name: string; policy: 'blocked' | 'available' | 'preinstalled' }
interface Workspace { id: string; name: string }

const isTeamWide = (r: Rule) => !r.workspaceId && !r.roleSlug && !r.environment && !r.resource;

/**
 * Settings → Connected apps → Agent access. What agents asked for beyond their
 * role, what they hold now, what was decided and by whom, and the team policy
 * that answers the next ask. Everything here reads and writes through
 * /api/agent-capabilities (session only); a member sees it all and changes
 * nothing, because the API refuses them the same writes. Nothing is decided
 * on this page: a button posts, and the row shows what the server answered.
 */
export default function AgentAccessSection({
  teamId,
  workspaces,
  focusRequestId = null,
}: {
  teamId: string | null;
  workspaces: Workspace[];
  /** `?request=<id>`: the row a Needs You link or push points at. */
  focusRequestId?: string | null;
}) {
  const [requests, setRequests] = useState<AccessRequestView[]>([]);
  const [canDecide, setCanDecide] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const q = teamId ? `teamId=${encodeURIComponent(teamId)}` : '';

  const loadRequests = useCallback(async () => {
    const res = await fetch(`/api/agent-capabilities/requests?${q}${q ? '&' : ''}limit=100`).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json() as { requests?: AccessRequestView[]; canDecide?: boolean };
    setRequests(data.requests ?? []);
    setCanDecide(!!data.canDecide);
  }, [q]);

  const loadPolicy = useCallback(async () => {
    const res = await fetch(`/api/agent-capabilities/policy${q ? `?${q}` : ''}`).catch(() => null);
    if (!res?.ok) return;
    const data = await res.json() as { rules?: Rule[]; canManage?: boolean };
    setRules(data.rules ?? []);
    setCanManage(!!data.canManage);
  }, [q]);

  useEffect(() => {
    void (async () => {
      const catalog = fetch('/api/connectors/catalog').then(r => (r.ok ? r.json() : { entries: [] })).catch(() => ({ entries: [] }));
      const [, , cat] = await Promise.all([loadRequests(), loadPolicy(), catalog]);
      setProviders(((cat as { entries?: CatalogProvider[] }).entries ?? []).map(e => ({ slug: e.slug, name: e.name, policy: e.policy })));
      setLoaded(true);
    })();
  }, [loadRequests, loadPolicy]);

  const pending = requests.filter(r => r.status === 'pending');
  const active = requests.filter(r => r.status === 'granted');
  const past = requests.filter(r => r.status !== 'pending' && r.status !== 'granted');

  if (!loaded) return null;

  return (
    <div id="agent-access" className="scroll-mt-20">
      <Section title="Agent access">
        <p className="mb-3 text-sm text-text-secondary">
          Agents ask for tools their role lacks, and team policy answers.{' '}
          Installing a connector grants agents nothing. Writes always need a person.
        </p>
        {message && (
          <Notice tone={message.tone} className="mb-3" data-testid="access-message">{message.text}</Notice>
        )}

        <h3 className="section-label mb-1">Waiting for a decision</h3>
        {pending.length === 0 ? (
          <p className="py-2 text-sm text-text-muted" data-testid="access-pending-empty">No requests are waiting.</p>
        ) : (
          <ul className="divide-y divide-border-default border-y border-border-default" data-testid="access-pending">
            {pending.map(r => (
              <RequestRow key={r.id} r={r} canDecide={canDecide} focused={r.id === focusRequestId} onDecided={async (text, ok) => { setMessage({ tone: ok ? 'ok' : 'err', text }); await loadRequests(); }} />
            ))}
          </ul>
        )}
        {!canDecide && pending.length > 0 && (
          <p className="mt-2 text-xs text-text-muted" data-testid="access-member-note">Only team owners and admins can approve or deny.</p>
        )}

        {active.length > 0 && (
          <>
            <h3 className="section-label mb-1 mt-5">Allowed now</h3>
            <ul className="divide-y divide-border-default border-y border-border-default" data-testid="access-active">
              {active.map(r => (
                <RequestRow key={r.id} r={r} canDecide={canDecide} focused={r.id === focusRequestId} onDecided={async (text, ok) => { setMessage({ tone: ok ? 'ok' : 'err', text }); await loadRequests(); }} />
              ))}
            </ul>
          </>
        )}

        {past.length > 0 && (
          <Disclosure summary={<span className="text-sm">History · {past.length}</span>} className="mt-4">
            <ul className="divide-y divide-border-default" data-testid="access-history">
              {past.map(r => <RequestRow key={r.id} r={r} canDecide={false} focused={r.id === focusRequestId} onDecided={async () => {}} />)}
            </ul>
          </Disclosure>
        )}
      </Section>

      <PolicySection
        rules={rules}
        canManage={canManage}
        providers={providers}
        workspaces={workspaces}
        teamQuery={q}
        onChanged={async (text, ok) => { setMessage({ tone: ok ? 'ok' : 'err', text }); await loadPolicy(); }}
      />
    </div>
  );
}

function RequestRow({ r, canDecide, focused, onDecided }: {
  r: AccessRequestView;
  canDecide: boolean;
  focused: boolean;
  onDecided: (text: string, ok: boolean) => void | Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [lease, setLease] = useState(String(r.ttlSeconds));
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focused) ref.current?.scrollIntoView({ block: 'center' }); }, [focused]);

  async function decide(decision: 'approve' | 'deny' | 'revoke') {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/agent-capabilities/requests/${encodeURIComponent(r.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decision === 'approve' ? { decision, ttlSeconds: Number(lease) } : { decision }),
      });
      const out = decisionResultText(decision, res.status, await res.json().catch(() => ({})));
      await onDecided(out.text, out.ok);
    } catch {
      await onDecided('Could not reach the server.', false);
    } finally {
      setBusy(false);
    }
  }

  const choices = leaseChoices(r.ttlSeconds);
  return (
    <li
      ref={ref}
      className={`py-3 ${focused ? 'bg-surface-2 -mx-2 px-2' : ''}`}
      aria-current={focused ? 'true' : undefined}
      data-testid={`access-request-${r.id}`}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary [overflow-wrap:anywhere]">{accessAsk(r)}</span>
            {(r.risk === 'write' || r.risk === 'admin') && <TonePill tone="act">{RISK_LABEL[r.risk]}</TonePill>}
          </div>
          <div className="mt-0.5 text-xs text-text-secondary [overflow-wrap:anywhere]">
            {accessWho(r)}
            {r.reason?.trim() && <> · &ldquo;{r.reason.trim()}&rdquo;</>}
          </div>
          <div className="mt-0.5 text-xs text-text-muted" data-testid="access-status-line">{accessStatusLine(r)}</div>
        </div>
        {canDecide && r.status === 'pending' && (
          <div className="flex flex-wrap items-center gap-2 sm:flex-shrink-0 sm:justify-end">
            {choices.length > 1 && (
              <Select
                aria-label="Lease"
                size="sm"
                value={lease}
                onChange={setLease}
                options={choices.map(s => ({ value: String(s), label: formatLease(s) }))}
              />
            )}
            <button type="button" className="btn btn-sm min-h-11 md:min-h-0" disabled={busy} onClick={() => void decide('approve')}>
              {busy ? 'Saving…' : choices.length > 1 ? 'Approve' : approveLabel(r.ttlSeconds)}
            </button>
            <button type="button" className="btn btn-sm btn-quiet min-h-11 md:min-h-0" disabled={busy} onClick={() => void decide('deny')}>Deny</button>
          </div>
        )}
        {canDecide && r.status === 'granted' && (
          <div className="flex sm:flex-shrink-0">
            <button type="button" className="btn btn-sm btn-quiet min-h-11 md:min-h-0" disabled={busy} onClick={() => void decide('revoke')}>
              {busy ? 'Revoking…' : 'Revoke'}
            </button>
          </div>
        )}
      </div>
    </li>
  );
}

function PolicySection({ rules, canManage, providers, workspaces, teamQuery, onChanged }: {
  rules: Rule[];
  canManage: boolean;
  providers: CatalogProvider[];
  workspaces: Workspace[];
  teamQuery: string;
  onChanged: (text: string, ok: boolean) => void | Promise<void>;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const teamWide = useMemo(() => new Map(rules.filter(isTeamWide).map(r => [`${r.provider}|${r.risk}`, r])), [rules]);
  const narrower = rules.filter(r => !isTeamWide(r));
  // Every catalog provider the team sees, plus any a rule names that the catalog no longer lists.
  const rows = useMemo(() => {
    const out = new Map(providers.map(p => [p.slug, p]));
    for (const r of rules) if (!out.has(r.provider)) out.set(r.provider, { slug: r.provider, name: providerName(r.provider), policy: 'available' });
    return [...out.values()];
  }, [providers, rules]);
  const wsName = (id: string | null) => (id ? workspaces.find(w => w.id === id)?.name ?? 'a workspace' : null);
  const url = (extra = '') => `/api/agent-capabilities/policy${teamQuery || extra ? '?' : ''}${[teamQuery, extra].filter(Boolean).join('&')}`;

  async function put(body: Record<string, unknown>, label: string) {
    setSaving(label);
    try {
      const res = await fetch(url(), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({})) as { message?: string; error?: string };
      await onChanged(res.ok ? 'Policy saved.' : data.message || data.error || 'Could not save the policy.', res.ok);
    } finally { setSaving(null); }
  }

  async function remove(rule: Rule, label: string) {
    setSaving(label);
    try {
      const res = await fetch(url(`id=${encodeURIComponent(rule.id)}`), { method: 'DELETE' });
      const data = await res.json().catch(() => ({})) as { message?: string; error?: string };
      await onChanged(res.ok ? 'Back to the default.' : data.message || data.error || 'Could not save the policy.', res.ok);
    } finally { setSaving(null); }
  }

  function setEffect(p: CatalogProvider, risk: AccessRisk, value: string) {
    const key = `${p.slug}|${risk}`;
    const rule = teamWide.get(key);
    if (value === DEFAULT) { if (rule) void remove(rule, key); return; }
    if (rule?.effect === value) return;
    void put({ provider: p.slug, risk, effect: value, maxTtlSeconds: rule?.maxTtlSeconds ?? undefined }, key);
  }

  if (rows.length === 0) return null;

  return (
    <Section title="Access policy">
      <p className="mb-3 text-sm text-text-secondary">
        For each provider and kind of access, what happens when an agent asks.
        {!canManage && ' Only team owners and admins can change this.'}
      </p>
      <ul className="divide-y divide-border-default border-y border-border-default" data-testid="access-policy">
        {rows.map(p => (
          <li key={p.slug} className="py-3" data-testid={`access-policy-${p.slug}`}>
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium text-text-primary">{p.name}</span>
              {p.policy === 'blocked' && <TonePill tone="bad">Blocked</TonePill>}
            </div>
            {p.policy === 'blocked' ? (
              <p className="text-xs text-text-secondary">Blocked in the catalog, so every request is refused whatever the policy says.</p>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {RISKS.map(risk => {
                  const rule = teamWide.get(`${p.slug}|${risk}`);
                  const current = rule ? rule.effect : DEFAULT;
                  return (
                    <div key={risk} className="min-w-0">
                      <span className="field-label">{RISK_LABEL[risk]}</span>
                      {canManage ? (
                        <Select
                          aria-label={`${p.name} ${RISK_LABEL[risk]}`}
                          size="sm"
                          value={current}
                          disabled={saving === `${p.slug}|${risk}`}
                          onChange={v => setEffect(p, risk, v)}
                          testId={`access-policy-${p.slug}-${risk}`}
                          options={[
                            { value: DEFAULT, label: `Default: ${defaultEffectText(risk)}` },
                            ...effectsFor(risk).map(e => ({ value: e, label: EFFECT_LABEL[e] })),
                          ]}
                          wrapLabels
                        />
                      ) : (
                        <p className="text-xs text-text-primary" data-testid={`access-policy-${p.slug}-${risk}-value`}>
                          {rule ? EFFECT_LABEL[rule.effect] : `Default: ${defaultEffectText(risk)}`}
                        </p>
                      )}
                      {rule?.maxTtlSeconds && <p className="mt-0.5 text-xs text-text-muted">At most {formatLease(rule.maxTtlSeconds)}</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </li>
        ))}
      </ul>

      {(narrower.length > 0 || canManage) && (
        <div className="mt-4">
          <h3 className="section-label mb-1">For one workspace or role</h3>
          {narrower.length === 0 ? (
            <p className="py-2 text-sm text-text-muted">No narrower rules. The team rules above apply everywhere.</p>
          ) : (
            <ul className="divide-y divide-border-default border-y border-border-default" data-testid="access-policy-narrower">
              {narrower.map(r => {
                const where = [wsName(r.workspaceId), r.roleSlug ? `role ${r.roleSlug}` : null, r.environment, r.resource].filter(Boolean).join(' · ');
                return (
                  <li key={r.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                    <span className="min-w-0 text-sm text-text-primary [overflow-wrap:anywhere]">
                      {RISK_LABEL[r.risk]} {providerName(r.provider)} in {where}: <span className="font-medium">{EFFECT_LABEL[r.effect]}</span>
                      {r.maxTtlSeconds ? <span className="text-text-muted">, at most {formatLease(r.maxTtlSeconds)}</span> : null}
                    </span>
                    {canManage && (
                      <button type="button" className="btn btn-sm btn-quiet min-h-11 self-start md:min-h-0" disabled={saving === r.id} onClick={() => void remove(r, r.id)}>Remove</button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {canManage && (
            <Disclosure summary={<span className="text-sm">Add a rule for one workspace or role</span>} className="mt-2">
              <NarrowRuleForm providers={rows.filter(p => p.policy !== 'blocked')} workspaces={workspaces} saving={saving === 'narrow'} onSubmit={body => put(body, 'narrow')} />
            </Disclosure>
          )}
        </div>
      )}
    </Section>
  );
}

const LEASE_CAPS = [15 * 60, 60 * 60, 4 * 60 * 60, 24 * 60 * 60];

function NarrowRuleForm({ providers, workspaces, saving, onSubmit }: {
  providers: CatalogProvider[];
  workspaces: Workspace[];
  saving: boolean;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  const [provider, setProvider] = useState(providers[0]?.slug ?? '');
  const [risk, setRisk] = useState<AccessRisk>('query');
  const [workspaceId, setWorkspaceId] = useState('');
  const [roleSlug, setRoleSlug] = useState('');
  const [effect, setEffect] = useState<AccessEffect>('ask_human');
  const [cap, setCap] = useState('');
  const [roles, setRoles] = useState<{ slug: string; name: string }[]>([]);

  useEffect(() => {
    void fetch('/api/roles').then(r => (r.ok ? r.json() : { roles: [] })).then((d: { roles?: { slug: string; name: string }[] }) => setRoles(d.roles ?? [])).catch(() => {});
  }, []);
  // A write or admin rule cannot allow automatically; keep the choice valid.
  useEffect(() => { if (!effectsFor(risk).includes(effect)) setEffect('ask_human'); }, [risk, effect]);

  const ready = !!provider && (!!workspaceId || !!roleSlug);
  return (
    <form
      className="grid grid-cols-1 gap-3 pb-2 pt-1 sm:grid-cols-2"
      data-testid="access-narrow-form"
      onSubmit={e => {
        e.preventDefault();
        if (!ready) return;
        void onSubmit({ provider, risk, effect, workspaceId: workspaceId || null, roleSlug: roleSlug || null, maxTtlSeconds: cap ? Number(cap) : null });
      }}
    >
      <div><span className="field-label">Provider</span><Select aria-label="Provider" value={provider} onChange={setProvider} options={providers.map(p => ({ value: p.slug, label: p.name }))} /></div>
      <div><span className="field-label">Access</span><Select aria-label="Access" value={risk} onChange={v => setRisk(v as AccessRisk)} options={RISKS.map(r => ({ value: r, label: RISK_LABEL[r] }))} /></div>
      <div><span className="field-label">Workspace</span><Select aria-label="Workspace" value={workspaceId} onChange={setWorkspaceId} placeholder="Any workspace" options={[{ value: '', label: 'Any workspace' }, ...workspaces.map(w => ({ value: w.id, label: w.name }))]} /></div>
      <div><span className="field-label">Role</span><Select aria-label="Role" value={roleSlug} onChange={setRoleSlug} placeholder="Any role" options={[{ value: '', label: 'Any role' }, ...roles.map(r => ({ value: r.slug, label: r.name }))]} /></div>
      <div><span className="field-label">Then</span><Select aria-label="Then" value={effect} onChange={v => setEffect(v as AccessEffect)} options={effectsFor(risk).map(e => ({ value: e, label: EFFECT_LABEL[e] }))} /></div>
      <div><span className="field-label">Longest lease</span><Select aria-label="Longest lease" value={cap} onChange={setCap} placeholder="Team default" options={[{ value: '', label: 'Team default' }, ...LEASE_CAPS.map(s => ({ value: String(s), label: formatLease(s) }))]} /></div>
      <div className="flex items-center justify-between gap-3 sm:col-span-2">
        <span className="text-xs text-text-muted">{ready ? '' : 'Pick a workspace or a role.'}</span>
        <button type="submit" className="btn btn-primary" disabled={saving || !ready}>{saving ? 'Saving…' : 'Add rule'}</button>
      </div>
    </form>
  );
}
