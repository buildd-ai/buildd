'use client';

/**
 * The one mission card, on Home and the missions list
 * (docs/design/mission-feed-mobile-continuity.md, W1, addendum D7).
 *
 * Renders a `MissionCardView` and nothing else — the chip, the sentence, the
 * pulse and the primary line were all decided by `buildMissionCardView`, so
 * Home and the list cannot describe one mission two ways.
 *
 * - Full: `MissionMasthead size="card"` (title, one chip, situation line,
 *   pulse, `n/N` caption, one primary line). When the mission has a
 *   time-axis strip, `⤢` opens it in `FlightDetailSheet` (D4: the strip lives
 *   only there on mobile).
 * - Compact (completed): title and one `Completed <when> · n/n` line. No
 *   pulse, no strip (D7).
 */
import Link from 'next/link';
import { useCallback, useState, type ReactNode } from 'react';
import { FlightDetailSheet } from '@/components/FlightDetailSheet';
import { compactCardLine, type MissionCardView } from '@/lib/mission-card-view';
import { timeAgo } from '@/lib/mission-helpers';
import type { MissionOrigin } from '@/lib/mission-task-href';
import MissionMasthead from './MissionMasthead';

export interface MissionCardProps {
  view: MissionCardView;
  /** An inline control beside the pulse (e.g. Arm for a held mission). */
  actions?: ReactNode;
  className?: string;
}

function originOf(href: string): MissionOrigin | null {
  const m = /[?&]from=([^&#]+)/.exec(href);
  return m ? (decodeURIComponent(m[1]) as MissionOrigin) : null;
}

function FlightDetailTrigger({ view }: { view: MissionCardView }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  if (!view.flightStrip) return null;
  return (
    <>
      <button
        type="button"
        data-testid="mission-card-expand"
        aria-label="Open flight detail"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className="flex h-11 w-11 items-center justify-center font-mono text-[14px] text-text-muted hover:text-text-primary"
      >
        ⤢
      </button>
      <FlightDetailSheet
        open={open}
        onClose={close}
        data={view.flightStrip}
        missionId={view.id}
        missionTitle={view.title}
        from={originOf(view.href)}
        taskTitles={view.flightStripTaskTitles}
      />
    </>
  );
}

export default function MissionCard({ view, actions, className = '' }: MissionCardProps) {
  if (view.compact) {
    return (
      <article
        data-testid="mission-card-compact"
        data-group={view.group}
        className={`relative border border-border-default bg-card px-3 py-2 ${className}`}
      >
        <Link
          href={view.href}
          className="block truncate font-mono text-[13px] font-medium text-text-secondary after:absolute after:inset-0 after:content-[''] hover:text-text-primary"
        >
          {view.title}
        </Link>
        <p className="mt-0.5 font-mono text-[11px] text-text-muted">{compactCardLine(view, timeAgo)}</p>
      </article>
    );
  }

  return (
    <div data-testid="mission-card" data-group={view.group} className={className}>
      <MissionMasthead
        size="card"
        title={view.title}
        chip={view.chip}
        situation={view.situation}
        segments={view.segments}
        caption={view.caption}
        href={view.href}
        primary={view.primary ? { label: view.primary.label, href: view.primary.href } : null}
        actions={actions}
        expand={view.flightStrip ? <FlightDetailTrigger view={view} /> : null}
      />
    </div>
  );
}
