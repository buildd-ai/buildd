/**
 * The mission page's md-and-up list view, named by `?view=`
 * (docs/design/mission-feed-mobile-continuity.md, "Desktop adaptation").
 * A plain module: the server page parses the param and the client toggle
 * (`MissionTabs`) shares the type.
 */
export type MissionListView = 'timeline' | 'structure';

export function parseMissionListView(raw: string | null | undefined): MissionListView {
  return raw === 'structure' ? 'structure' : 'timeline';
}

/**
 * The md+ list views sit in a closed disclosure under the feed. A URL that
 * names a non-default view (a deep link, or a reload after toggling) opens it,
 * so the view the URL names is on screen.
 */
export function missionListViewOpensDisclosure(raw: string | null | undefined): boolean {
  return parseMissionListView(raw) === 'structure';
}
