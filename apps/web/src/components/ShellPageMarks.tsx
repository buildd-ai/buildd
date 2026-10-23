'use client';

import { useHideNeedsInputBanner } from '@/lib/needs-input-hidden';
import { useClaimNavSection } from '@/lib/nav-section-store';

/**
 * What a server-rendered page tells the app shell about itself (spec d25d923d:
 * every page answers one question and shows a thing once). Renders nothing.
 *
 * - `hideQuestionsBanner`: the page shows its own decisions as cards (mission
 *   page) or asks its question in place (task page), and Home and the nav badge
 *   carry the rest, so the layout's "N questions for you" banner steps aside.
 * - `navSection`: the nav destination that owns the page when its path cannot
 *   say, e.g. Missions for a mission's task at `/app/tasks/<id>`.
 */
export default function ShellPageMarks({ hideQuestionsBanner = false, navSection = null }: {
  hideQuestionsBanner?: boolean;
  navSection?: string | null;
}) {
  useHideNeedsInputBanner(hideQuestionsBanner);
  useClaimNavSection(navSection);
  return null;
}
