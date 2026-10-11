'use client';

/**
 * A task waiting on a plan limit (packages/shared/src/entitlements.ts).
 *
 * Not an error and never drawn like one: neutral surface, an info chip, the
 * plan's limit in plain words, that the task starts by itself, and one way to
 * raise the limit. Every commercial limit renders through this component;
 * the copy per kind lives in lib/entitlements/presentation.ts.
 *
 * "Leave queued" collapses it to one line. Nothing changes on the task: it
 * stays queued either way.
 */
import { useState } from 'react';
import type { EntitlementBlock } from '@buildd/shared';
import Chip from '@/components/ui/Chip';
import Link from 'next/link';
import PrimaryAction from '@/components/ui/PrimaryAction';
import { describeEntitlementBlock } from '@/lib/entitlements/presentation';

/** Hosted billing sets the URL; self-hosted installs never render a block. */
const UPGRADE_HREF = process.env.NEXT_PUBLIC_BUILDD_UPGRADE_URL || '/app/settings';

export interface EntitlementBlockedNoticeProps {
  block: EntitlementBlock;
  /** Called on "Leave queued" (e.g. to close a start refusal). Collapses in place when omitted. */
  onLeaveQueued?: () => void;
  upgradeHref?: string;
  /** Start collapsed (fixtures; a host that already said it is queued). */
  defaultCollapsed?: boolean;
}

export default function EntitlementBlockedNotice({ block, onLeaveQueued, upgradeHref = UPGRADE_HREF, defaultCollapsed = false }: EntitlementBlockedNoticeProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const copy = describeEntitlementBlock(block);

  if (collapsed) {
    return (
      <div data-testid="entitlement-blocked" data-kind={block.kind} data-collapsed="true" role="status" className="flex flex-wrap items-center gap-2 border border-border-default p-3">
        <Chip tone="info">{copy.state}</Chip>
        <span className="min-w-0 text-meta text-text-secondary">{copy.title}</span>
      </div>
    );
  }

  return (
    <section
      data-testid="entitlement-blocked"
      data-kind={block.kind}
      data-entitlement={block.key}
      role="status"
      className="space-y-3 border border-border-default bg-surface-2 p-4"
    >
      <Chip tone="info">{copy.state}</Chip>
      <div className="space-y-1">
        <p className="text-body font-medium text-text-primary">{copy.title}</p>
        <p className="text-meta text-text-secondary">{copy.body}</p>
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        <PrimaryAction href={upgradeHref} fullWidthOnMobile data-testid="entitlement-upgrade">
          {copy.upgradeLabel}
        </PrimaryAction>
        {copy.alternative && (
          <Link href={copy.alternative.href} data-testid="entitlement-alternative" className="btn min-h-11 w-full md:w-auto">
            {copy.alternative.label}
          </Link>
        )}
        <button
          type="button"
          data-action="leave_queued"
          onClick={() => (onLeaveQueued ? onLeaveQueued() : setCollapsed(true))}
          className="btn btn-quiet min-h-11 w-full md:w-auto"
        >
          {copy.waitLabel}
        </button>
      </div>
      <p className="text-eyebrow text-text-muted">{copy.footnote}</p>
    </section>
  );
}
