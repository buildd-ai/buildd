'use client';

import { useState } from 'react';
import SideSheet from '@/components/SideSheet';
import MissionSettings from './MissionSettings';
import type { MissionDisplayState } from '@/lib/mission-helpers';

interface Props {
  missionId: string;
  currentStatus: string;
  cronExpression: string | null;
  workspaceId: string | null;
  roles: { slug: string; name: string; color: string }[];
  hasSchedule: boolean;
  orchestrationMode?: 'auto' | 'manual';
  isHeld: boolean;
  displayState: MissionDisplayState;
  hasPrimaryAction?: boolean;
  executor?: 'runner' | 'local' | null;
}

/**
 * "⋮" overflow button — MissionSettings relocated behind it, in the same
 * bottom-sheet mechanism as the Verified pill. Only where it's triggered
 * from changes; MissionSettings' own archive/delete logic is untouched.
 */
export default function MissionOverflowMenu(props: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="More actions: settings, archive, delete"
        className="shrink-0 w-11 h-11 -mr-2.5 flex items-center justify-center text-text-secondary hover:text-text-primary transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
          <rect x="2" y="8" width="3" height="3" />
          <rect x="7.5" y="8" width="3" height="3" />
          <rect x="13" y="8" width="3" height="3" />
        </svg>
      </button>
      <SideSheet open={open} onClose={() => setOpen(false)} title="Mission actions" testId="mission-actions-sheet">
        <MissionSettings {...props} />
      </SideSheet>
    </>
  );
}
