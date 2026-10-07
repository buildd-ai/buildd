'use client';

import { useState } from 'react';
import Link from 'next/link';
import Chip from '@/components/ui/Chip';
import type { ModelUpgradeNotice as Notice } from '@/lib/model-upgrade-notice';

/**
 * Home notice: a tier left on a deprecated or superseded model by the team's
 * upgrade policy or a pin (lib/model-upgrade-notice.ts). Review opens Settings →
 * Models; Adopt (manual policy only) takes every certified model in one click;
 * Snooze hides this exact notice for a week, and a new deprecation or release
 * produces a different notice that is not snoozed.
 */
export default function ModelUpgradeNotice({ notice, teamId }: { notice: Notice; teamId: string }) {
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (hidden) return null;

  async function act(url: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Could not save');
      setHidden(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const deprecated = notice.kind === 'deprecated';
  return (
    <div
      className={`card mb-4 flex flex-col gap-2 border-l-2 px-3 py-2 ${deprecated ? 'border-status-error' : 'border-status-warning'}`}
      data-testid="model-upgrade-notice"
      data-kind={notice.kind}
    >
      <div className="flex items-center gap-2">
        <Chip tone={deprecated ? 'error' : 'warning'} variant="soft">{deprecated ? 'Deprecated' : 'Newer model'}</Chip>
        <span className="text-body text-text-primary">{notice.headline}</span>
      </div>
      <ul className="flex flex-col gap-1 text-meta text-text-secondary">
        {notice.items.map((i) => <li key={i.tier}>{i.text}</li>)}
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        {notice.canAdopt && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            data-testid="model-upgrade-notice-adopt"
            onClick={() => void act('/api/model-tiers/policy/adopt', { teamId })}
          >
            Adopt
          </button>
        )}
        <Link href="/app/settings/models#model-upgrades" className="text-meta text-accent-text underline">
          Review model policy
        </Link>
        <button
          type="button"
          className="text-meta text-text-muted underline"
          disabled={busy}
          onClick={() => void act('/api/action-queue/snooze', { subjectKey: notice.subjectKey, hours: 168 })}
        >
          Snooze for a week
        </button>
        {error && <span role="status" className="text-meta text-status-error">{error}</span>}
      </div>
    </div>
  );
}
