'use client';

/**
 * Settings › You › Keys › My maximum: the most expensive tier your own work
 * may use, in the active team (the `member_self` layer of
 * docs/specs/model-tier-ceilings.md). Yours alone: `PUT
 * /api/teams/[id]/model-ceilings/me`, which no admin or key can write. Options
 * above what the team or an admin allows are disabled with the reason; the
 * read model is refetched after every write and a refused write shows the
 * server's message.
 */
import { useCallback, useEffect, useState } from 'react';
import type { CeilingSurface, CeilingTier, SurfaceCeilings } from '@buildd/shared';
import Section from '@/components/ui/Section';
import Notice from '@/components/ui/Notice';
import { boundForAll, boundFrom, withCap } from '@/lib/tier-limits-view';
import { Limit } from './TierLimitSection';

interface Effective {
  max: CeilingTier | null;
  binding: { source: string; tier: CeilingTier } | null;
  layers: { source: string; tier: CeilingTier }[];
}
interface Ceilings {
  me: { admin: SurfaceCeilings; self: SurfaceCeilings } | null;
  effective: Record<CeilingSurface, Effective>;
}

const LOAD_ERROR = "Couldn't load your maximum.";

export default function MyMaximumSection({ teamId }: { teamId: string }) {
  const [data, setData] = useState<Ceilings | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/teams/${teamId}/model-ceilings`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) { setLoadError(true); return; }
    setData(await res.json());
    setLoadError(false);
  }, [teamId]);
  useEffect(() => { void load(); }, [load]);

  async function write(ceilings: SurfaceCeilings) {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/model-ceilings/me`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ceilings }),
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

  const me = data?.me ?? null;
  const otherAgent = data ? boundFrom(data.effective.agent, 'member_self') : null;
  const otherChat = data ? boundFrom(data.effective.chat, 'member_self') : null;
  const bound = { all: boundForAll(otherAgent, otherChat), agent: otherAgent, chat: otherChat };

  return (
    <Section title="My maximum" id="my-maximum" className="scroll-mt-20">
      <div data-testid="my-limit">
        {loadError && !data && (
          <Notice tone="err" action={{ label: 'Retry', onClick: () => { void load(); } }}>{LOAD_ERROR}</Notice>
        )}
        {!data && !loadError && <p className="text-meta text-text-muted">Loading…</p>}
        {me && (
          <>
            <p id="self-title" className="mb-2 text-body text-text-secondary">
              The most expensive tier your work may use. Only lower than the team{me.admin && Object.keys(me.admin).length ? ' and your admin' : ''}.
            </p>
            <Limit id="self" titleId="self-title" caps={me.self} bound={bound} boundBy="the team or workspace"
              disabled={busy} onPick={(k, v) => void write(withCap(me.self, k, v))} />
          </>
        )}
        {msg && (
          <span role={msg.tone === 'err' ? 'alert' : 'status'} className={`mt-1 block text-meta ${msg.tone === 'ok' ? 'text-status-success' : 'text-status-error'}`}>
            {msg.text}
          </span>
        )}
      </div>
    </Section>
  );
}
