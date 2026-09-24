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
