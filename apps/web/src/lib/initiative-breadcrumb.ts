/** Builds the mission URL with initiative passthrough query params. */
export function buildMissionWithInitiativeUrl(missionId: string, initiativeId: string): string {
  return `/app/missions/${missionId}?from=initiative&initiativeId=${initiativeId}`;
}

export type MissionBreadcrumb =
  | {
      type: 'missions';
      links: [{ label: 'Missions'; href: '/app/missions' }];
      currentLabel: string;
    }
  | {
      type: 'initiative';
      links: [
        { label: 'Initiatives'; href: '/app/initiatives' },
        { label: string; href: string },
      ];
      currentLabel: string;
    };

const DEFAULT_CRUMB = (missionTitle: string): MissionBreadcrumb => ({
  type: 'missions',
  links: [{ label: 'Missions', href: '/app/missions' }],
  currentLabel: missionTitle,
});

/**
 * Resolves the breadcrumb config for a mission detail page.
 *
 * Priority order:
 * 1. URL param (from=initiative + initiativeId + initiativeName) — preserves navigation context
 * 2. DB-stored initiative (dbInitiativeId + dbInitiativeName) — always shown even on direct nav
 * 3. Default: "Missions / mission title"
 */
export function resolveMissionBreadcrumb({
  from,
  initiativeId,
  initiativeName,
  dbInitiativeId,
  dbInitiativeName,
  missionTitle,
}: {
  from: string | undefined;
  initiativeId: string | undefined;
  initiativeName: string | undefined;
  dbInitiativeId: string | undefined | null;
  dbInitiativeName: string | undefined | null;
  missionTitle: string;
}): MissionBreadcrumb {
  // URL param takes priority (navigation context from clicking through an initiative page)
  if (from === 'initiative' && initiativeId && initiativeName) {
    return {
      type: 'initiative',
      links: [
        { label: 'Initiatives', href: '/app/initiatives' },
        { label: initiativeName, href: `/app/initiatives/${initiativeId}` },
      ],
      currentLabel: missionTitle,
    };
  }
  // DB-stored initiative — always show even on direct navigation
  if (dbInitiativeId && dbInitiativeName) {
    return {
      type: 'initiative',
      links: [
        { label: 'Initiatives', href: '/app/initiatives' },
        { label: dbInitiativeName, href: `/app/initiatives/${dbInitiativeId}` },
      ],
      currentLabel: missionTitle,
    };
  }
  return DEFAULT_CRUMB(missionTitle);
}
