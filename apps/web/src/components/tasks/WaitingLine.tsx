'use client';

/**
 * WaitingLine: why a pending task is not running, in one compact line —
 * `{chip} Waiting on {blocker} · because {reason} · starts when {release}` —
 * with a "Why" drilldown for every reason, its overlap areas and the paths.
 * Renders the canonical `WaitingReason[]` (packages/core/waiting-reason.ts);
 * no surface builds its own reason copy. Mounted by `TaskActionZone`, so the
 * task sheet, the full task page and the mission drawer all show it.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import Disclosure from '@/components/ui/Disclosure';
import { gateName, orderWaitingReasons, waitingChip, type WaitingChip, type WaitingReason } from '@buildd/core/waiting-reason';

const CHIP_LABEL: Record<WaitingChip, string> = {
  ready: 'Ready', held: 'Held', blocked: 'Blocked', cant_run: "Can't run", scheduled: 'Scheduled', unknown: 'Unknown',
};
const CHIP_TONE: Record<WaitingChip, string> = {
  ready: 'border-border-default text-text-secondary',
  held: 'border-status-warning text-status-warning',
  blocked: 'border-border-strong text-text-secondary',
  cant_run: 'border-status-error text-status-error',
  scheduled: 'border-border-default text-text-secondary',
  unknown: 'border-dashed border-border-default text-text-muted',
};

function BlockerLink({ r }: { r: WaitingReason }) {
  const b = r.blocker;
  if (!b) return <span>{gateName(r.kind).toLowerCase()}</span>;
  const cls = 'text-accent-text hover:underline [overflow-wrap:anywhere]';
  if (!b.href) return <span className="[overflow-wrap:anywhere]">{b.label}</span>;
  return b.href.startsWith('http')
    ? <a href={b.href} target="_blank" rel="noopener noreferrer" className={cls}>{b.label} ↗</a>
    : <Link href={b.href} className={cls}>{b.label}</Link>;
}

export default function WaitingLine({ reasons, children }: { reasons: WaitingReason[]; children?: ReactNode }) {
  const ordered = orderWaitingReasons(reasons);
  const head = ordered[0];
  if (!head) return null;
  const chip = waitingChip(ordered);
  const rest = ordered.slice(1);

  return (
    <div data-testid="task-waiting-line" data-kind={head.kind} data-chip={chip} className="space-y-2 border border-border-default p-3">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 font-mono text-meta">
        <span className={`border px-1.5 py-0.5 text-chip font-semibold uppercase tracking-[1.4px] ${CHIP_TONE[chip]}`}>{CHIP_LABEL[chip]}</span>
        <span className="font-medium text-text-primary">Waiting on <BlockerLink r={head} /></span>
      </p>
      <p className="font-mono text-eyebrow leading-relaxed text-text-secondary [overflow-wrap:anywhere]">
        because {head.because} · starts when {head.releasesWhen.text}
      </p>
      {rest.length > 0 && (
        <p className="font-mono text-eyebrow text-text-muted">
          Also: {rest.map(r => gateName(r.kind).toLowerCase()).join(', ')}
        </p>
      )}
      <Disclosure summary="Why">
        <ul className="space-y-3 pt-2">
          {ordered.map((r, i) => (
            <li key={`${r.kind}-${r.blocker?.id ?? i}`} data-testid="task-waiting-reason" data-kind={r.kind} className="space-y-1 font-mono text-eyebrow">
              <p className="font-medium text-text-primary">
                {gateName(r.kind)}{r.strength === 'soft' ? ' (ordering only)' : ''}
                {!r.action.force && r.strength === 'hard' ? <span className="ml-1.5 text-text-muted">· can't be forced</span> : null}
              </p>
              <p className="text-text-secondary [overflow-wrap:anywhere]"><BlockerLink r={r} />: {r.because}.</p>
              {r.overlap && r.overlap.areas.length > 0 && (
                <p className="flex flex-wrap gap-1">
                  {r.overlap.areas.map(a => (
                    <span key={a.area} className="border border-border-default px-1 text-text-muted">{a.area}{a.count > 1 ? ` ×${a.count}` : ''}</span>
                  ))}
                </p>
              )}
              {r.overlap?.paths && r.overlap.paths.length > 0 && (
                <Disclosure summary="Files" count={r.overlap.pathCount}>
                  <ul className="max-h-40 space-y-0.5 overflow-auto bg-surface-2 p-2 text-text-secondary">
                    {r.overlap.paths.map(p => <li key={p} className="[overflow-wrap:anywhere]">{p}</li>)}
                  </ul>
                </Disclosure>
              )}
              <p className="text-text-muted" title={r.provenance.derivedFrom}>
                {r.provenance.source === 'ledger' ? 'From the claim log.' : 'Checked just now with the rules a runner claim uses.'}
              </p>
            </li>
          ))}
        </ul>
      </Disclosure>
      {children}
    </div>
  );
}
