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
 * When `from=initiative`, `initiativeId`, and a non-empty `initiativeName` are
 * all present, returns the three-level initiative breadcrumb. Otherwise returns
 * the standard two-level missions breadcrumb (no regression for direct nav).
 */
export function resolveMissionBreadcrumb({
  from,
  initiativeId,
  initiativeName,
  missionTitle,
}: {
  from: string | undefined;
  initiativeId: string | undefined;
  initiativeName: string | undefined;
  missionTitle: string;
}): MissionBreadcrumb {
  if (from !== 'initiative' || !initiativeId || !initiativeName) {
    return DEFAULT_CRUMB(missionTitle);
  }
  return {
    type: 'initiative',
    links: [
      { label: 'Initiatives', href: '/app/initiatives' },
      { label: initiativeName, href: `/app/initiatives/${initiativeId}` },
    ],
    currentLabel: missionTitle,
  };
}
