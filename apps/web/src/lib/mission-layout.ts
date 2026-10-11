/**
 * The mission page's three layouts: Overview (`board`, default), Flow and
 * History (`feed`). `?layout=` names one. Old links still land where they
 * pointed: `?layout=lanes` and `?view=structure` open Flow (it replaced Lanes
 * and the Structure graph), and `?view=timeline` opens History.
 */
export const MISSION_LAYOUTS = ['board', 'flow', 'feed'] as const;
export type MissionLayout = (typeof MISSION_LAYOUTS)[number];

export const MISSION_LAYOUT_LABEL: Record<MissionLayout, string> = {
  board: 'Overview',
  flow: 'Flow',
  feed: 'History',
};

/** The tabs, in order: Overview · Flow · History. */
export const MISSION_LAYOUT_TABS: readonly MissionLayout[] = ['board', 'flow', 'feed'];

export function parseMissionLayout(layout: string | null | undefined, view?: string | null): MissionLayout {
  if ((MISSION_LAYOUTS as readonly string[]).includes(layout ?? '')) return layout as MissionLayout;
  if (layout === 'lanes' || view === 'structure') return 'flow';
  if (view === 'timeline') return 'feed';
  return 'board';
}

/** The current URL with `layout=` set (Board, the default, drops the param). */
export function missionLayoutHref(currentHref: string, layout: MissionLayout): string {
  const url = new URL(currentHref, 'http://x');
  if (layout === 'board') url.searchParams.delete('layout');
  else url.searchParams.set('layout', layout);
  if (layout !== 'feed') url.searchParams.delete('view');
  const qs = url.searchParams.toString();
  return `${url.pathname}${qs ? `?${qs}` : ''}${url.hash}`;
}
