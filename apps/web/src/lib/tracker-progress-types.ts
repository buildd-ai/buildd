/**
 * Shared response contract for the Phase 2 read-back tracking endpoints
 * (`GET /api/missions/[id]/tracker-progress` and
 * `GET /api/initiatives/[id]/tracker-progress`).
 *
 * Best-effort by design: a route always returns 200 with this shape when the
 * entity is accessible. An external (Linear) fetch failure never 500s the
 * route — it surfaces as an item with `percent: null` / `state: null` while
 * `linked` stays true.
 */

export interface TrackerProgressItem {
  kind: 'project' | 'issue';
  externalId: string;
  title: string | null;
  percent: number | null; // 0..100 or null
  state: string | null;
  url: string | null; // external_link.externalUrl
}

export interface TrackerProgressResponse {
  linked: boolean;
  provider: 'linear' | null;
  items: TrackerProgressItem[];
  fetchedAt: string; // new Date().toISOString()
}
