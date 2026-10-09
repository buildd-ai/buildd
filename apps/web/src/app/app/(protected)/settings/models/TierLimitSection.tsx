'use client';

/**
 * Settings → Model tiers → Maximum allowed. The enforced tier ceilings
 * (docs/specs/model-tier-ceilings.md): a team maximum, optional Coding and Chat
 * maximums, workspace and member overrides for admins, and every member's own
 * lower maximum. Everything shown comes from `GET /api/teams/[id]/model-ceilings`
 * and is refetched after each write: the browser never works out an effective
 * maximum, and a refused write shows the server's message.
 *
 * A maximum is a different thing from "New chats start at" (a default) and from
 * the dollar budgets (how much is spent), and from provider keys (which
 * providers can be called).
 */
import { useCallback, useEffect, useState } from 'react';
import type { CeilingSurface, CeilingTier, SurfaceCeilings } from '@buildd/shared';
import { Select } from '@/components/ui/Select';
import Chip from '@/components/ui/Chip';
import {
  SOURCE_LABEL, SURFACE_TITLE, TIER_LABEL, boundForAll, boundFrom, hasSurfaceCaps, limitOptions, toValue, withCap,
  type LimitValue,
} from '@/lib/tier-limits-view';

interface Effective {
  max: CeilingTier | null;
  binding: { source: string; tier: CeilingTier } | null;
  layers: { source: string; tier: CeilingTier }[];
  identified: boolean;
  overCapAuto: 'downgrade' | 'deny';
  explanation: string;
}
interface Ceilings {
  policy: { team: SurfaceCeilings; workspaces: Record<string, SurfaceCeilings>; overCapAuto: 'downgrade' | 'deny' };
  me: { admin: SurfaceCeilings; self: SurfaceCeilings } | null;
  effective: Record<CeilingSurface, Effective>;
  canManage: boolean;
  members?: Record<string, { admin?: SurfaceCeilings; self?: SurfaceCeilings }>;
}
interface Person { userId: string; name: string | null; email: string | null }
interface Workspace { id: string; name: string }

const SURFACES: CeilingSurface[] = ['agent', 'chat'];

function Limit({ id, label, caps, onPick, bound, boundBy, disabled, surface }: {
  id: string; label: string; caps: SurfaceCeilings | undefined; onPick: (key: 'all' | CeilingSurface, v: LimitValue) => void;
  bound?: { all: CeilingTier | null; agent: CeilingTier | null; chat: CeilingTier | null }; boundBy?: string; disabled: boolean; surface?: boolean;
}) {
  const [open, setOpen] = useState(hasSurfaceCaps(caps));
  useEffect(() => { if (hasSurfaceCaps(caps)) setOpen(true); }, [caps]);
  const pick = (key: 'all' | CeilingSurface, name: string) => (
    <div className="flex items-center justify-between gap-3" key={key}>
      <span id={`${id}-${key}-label`} className="text-body text-text-primary">{name}</span>
      <Select
        aria-labelledby={`${id}-${key}-label`}
        testId={`${id}-${key}`}
        className="w-44 shrink-0"
        options={limitOptions(bound?.[key] ?? null, boundBy)}
        value={toValue(caps?.[key])}
        disabled={disabled}
        onChange={(v: string) => onPick(key, v as LimitValue)}
      />
    </div>
  );
  return (
    <div className="flex flex-col gap-2" data-testid={id}>
      {pick('all', label)}
      {surface !== false && (
        <>
          <button type="button" className="self-start text-meta text-text-muted underline-offset-2 hover:underline" aria-expanded={open}
            data-testid={`${id}-advanced`} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Set'} Coding and Chat separately
          </button>
          {open && (
            <div className="flex flex-col gap-2 border-l border-border-default pl-3">
              {SURFACES.map((s) => pick(s, `${SURFACE_TITLE[s]} only`))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function TierLimitSection({ teamId, isAdmin }: { teamId: string; isAdmin: boolean }) {
  const [data, setData] = useState<Ceilings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/teams/${teamId}/model-ceilings`, { cache: 'no-store' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      setData(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not load tier maximums');
    }
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  const canManage = isAdmin && !!data?.canManage;
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    fetch(`/api/teams/${teamId}/members`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled && d?.members) setPeople(d.members); }).catch(() => {});
    fetch(`/api/workspaces?teamId=${teamId}`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (!cancelled && d?.workspaces) setWorkspaces(d.workspaces); }).catch(() => {});
    return () => { cancelled = true; };
  }, [teamId, canManage]);

  async function write(path: string, body: unknown) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/model-ceilings${path}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setMsg({ tone: 'ok', text: 'Saved' });
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      await load(); // the read model is the truth, saved or refused
      setBusy(false);
    }
  }

  if (loadError && !data) {
    return <section className="mt-6 max-w-5xl text-meta text-status-error" role="alert" data-testid="tier-limits-error">{loadError}</section>;
  }
  if (!data) return <section className="mt-6 max-w-5xl text-meta text-text-muted" data-testid="tier-limits-loading">Loading maximums…</section>;

  const { policy, me, effective } = data;
  const otherAgent = boundFrom(effective.agent, 'member_self');
  const otherChat = boundFrom(effective.chat, 'member_self');
  const selfBound = { all: boundForAll(otherAgent, otherChat), agent: otherAgent, chat: otherChat };
  const anyCap = SURFACES.some((s) => effective[s].max);
  const stateOf = (id: string) => (id === 'agent' ? effective.agent : effective.chat);

  return (
    <section className="mt-6 max-w-5xl" data-testid="tier-limits">
      <h2 className="font-mono text-body font-semibold text-text-primary">Maximum allowed</h2>
      <p className="mt-1 text-meta text-text-muted">
        The most expensive tier work may use. It is enforced on every task and chat, and nobody can pick past it.
        It does not set a spending budget (how much) or which provider keys are used.
      </p>

      <div className="card mt-3 flex flex-col gap-2 px-3 py-3" data-testid="tier-limits-effective">
        <span className="text-meta font-medium text-text-secondary">In effect for you</span>
        {!anyCap && <p className="text-body text-text-primary">No extra restriction. Every tier is allowed.</p>}
        {SURFACES.map((s) => {
          const e = stateOf(s);
          return (
            <div key={s} className="flex flex-col gap-0.5" data-testid={`effective-${s}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-body text-text-primary">{SURFACE_TITLE[s]}</span>
                <Chip tone={e.max ? 'accent' : 'muted'} variant="soft" dot={false}>{e.max ? `up to ${TIER_LABEL[e.max]}` : 'no limit'}</Chip>
              </div>
              {e.max && (
                <p className="text-meta text-text-muted">
                  {e.layers.map((l) => `${SOURCE_LABEL[l.source] ?? l.source} ${TIER_LABEL[l.tier]}`).join(' · ')}
                  {e.layers.length > 1 && e.binding ? ` → ${TIER_LABEL[e.max]} (lowest wins)` : e.binding ? ` — set by ${SOURCE_LABEL[e.binding.source]}` : ''}
                </p>
              )}
            </div>
          );
        })}
        <p className="text-meta text-text-muted">Premium-plus stays opt-in either way. Blocked tiers are refused with a reason, never swapped quietly.</p>
      </div>

      {me && (
        <div className="card mt-3 px-3 py-3" data-testid="my-limit">
          <span className="text-meta font-medium text-text-secondary">My maximum</span>
          <p className="mb-2 text-meta text-text-muted">Optional. You can only go lower than the team{me.admin && Object.keys(me.admin).length ? ' and your admin' : ''}; it never raises anything.</p>
          <Limit id="self" label="My maximum" caps={me.self} bound={selfBound} boundBy="the team or workspace"
            disabled={busy} onPick={(k, v) => void write('/me', { ceilings: withCap(me.self, k, v) })} />
        </div>
      )}
      {!me && <p className="mt-3 text-meta text-text-muted">A personal maximum belongs to a signed-in person; an API key has none.</p>}

      {canManage ? (
        <div className="card mt-3 flex flex-col gap-3 px-3 py-3" data-testid="team-limit">
          <span className="text-meta font-medium text-text-secondary">Team maximum</span>
          <Limit id="team" label="Team maximum" caps={policy.team} disabled={busy}
            onPick={(k, v) => void write('', { team: withCap(policy.team, k, v) })} />
          <div className="flex items-center justify-between gap-3">
            <span id="over-cap-label" className="text-body text-text-primary">Router picks higher: downgrade or hold?</span>
            <Select aria-labelledby="over-cap-label" testId="over-cap-auto" className="w-44 shrink-0" disabled={busy}
              options={[{ value: 'downgrade', label: 'Downgrade' }, { value: 'deny', label: 'Hold task' }]}
              value={policy.overCapAuto} onChange={(v: string) => void write('', { overCapAuto: v })} />
          </div>
          <p className="text-meta text-text-muted">Applies to automatic choices only. A task or chat that asks for a blocked tier is always refused.</p>
        </div>
      ) : (
        <p className="mt-3 text-meta text-text-muted" data-testid="team-limit-readonly">
          {policy.team.all || policy.team.agent || policy.team.chat ? 'The team maximum is set by a team admin.' : 'Your team has not set a maximum.'}
        </p>
      )}

      {canManage && workspaces.length > 0 && (
        <details className="card mt-3 px-3 py-3" data-testid="workspace-limits">
          <summary className="cursor-pointer text-meta font-medium text-text-secondary">Workspace maximums ({workspaces.length})</summary>
          <p className="my-2 text-meta text-text-muted">Applies together with the team maximum: the lower one wins.</p>
          <div className="flex flex-col gap-4">
            {workspaces.map((w) => (
              <Limit key={w.id} id={`ws-${w.id}`} label={w.name} caps={policy.workspaces[w.id]} disabled={busy}
                onPick={(k, v) => void write('', { workspaces: { [w.id]: withCap(policy.workspaces[w.id], k, v) } })} />
            ))}
          </div>
        </details>
      )}

      {canManage && people.length > 0 && (
        <details className="card mt-3 px-3 py-3" data-testid="member-limits">
          <summary className="cursor-pointer text-meta font-medium text-text-secondary">Member maximums ({people.length})</summary>
          <p className="my-2 text-meta text-text-muted">A member cannot raise what you set here. They may set a lower one of their own.</p>
          <div className="flex flex-col gap-4">
            {people.map((p) => {
              const m = data.members?.[p.userId];
              const label = p.name ?? p.email ?? p.userId;
              const own = m?.self && (m.self.all || m.self.agent || m.self.chat) ? m.self : null;
              return (
                <div key={p.userId} className="flex flex-col gap-1">
                  <Limit id={`member-${p.userId}`} label={label} caps={m?.admin} disabled={busy}
                    onPick={(k, v) => void write(`/members/${p.userId}`, { ceilings: withCap(m?.admin, k, v) })} />
                  {own && <p className="text-meta text-text-muted">Their own: {[own.all && `all ${TIER_LABEL[own.all]}`, own.agent && `Coding ${TIER_LABEL[own.agent]}`, own.chat && `Chat ${TIER_LABEL[own.chat]}`].filter(Boolean).join(', ')}</p>}
                </div>
              );
            })}
          </div>
        </details>
      )}

      <p className="mt-3 text-meta text-text-muted" data-testid="coding-route-note">
        Coding runs use a provider API route or a runner’s own sign-in, depending on how the runner is set up. A maximum limits the tier on either one;
        which one is used is set under Providers, not here.
      </p>

      {(msg || loadError) && (
        <span role={msg?.tone === 'err' || loadError ? 'alert' : 'status'} className={`mt-1 block text-meta ${msg?.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>
          {msg?.text ?? loadError}
        </span>
      )}
    </section>
  );
}
