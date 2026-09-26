/**
 * The mission page's three layouts: Board (default), Lanes and Feed. `?layout=`
 * names one; `?view=timeline|structure` (the Feed's Timeline · Structure
 * disclosure) implies Feed, so its old links still land where they pointed.
 */
export const MISSION_LAYOUTS = ['board', 'lanes', 'feed'] as const;
export type MissionLayout = (typeof MISSION_LAYOUTS)[number];

export const MISSION_LAYOUT_LABEL: Record<MissionLayout, string> = {
  board: 'Board',
  lanes: 'Lanes',
  feed: 'Feed',
};

export function parseMissionLayout(layout: string | null | undefined, view?: string | null): MissionLayout {
  if ((MISSION_LAYOUTS as readonly string[]).includes(layout ?? '')) return layout as MissionLayout;
  if (view === 'timeline' || view === 'structure') return 'feed';
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
