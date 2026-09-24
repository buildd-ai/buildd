/**
 * Lazy artifact bodies for the mission Records sheet
 * (docs/design/mission-feed-mobile-continuity.md, slice S7, AC-18). The mission
 * page renders artifact metadata only; the sheet fetches bodies when it opens.
 *
 * Shared by the route (`/api/missions/[id]/artifacts/content`) and the client,
 * so the cap and the URL shape cannot drift apart.
 */

/** Most ids one request may name — five artifacts per worker, a page of records. */
export const RECORDS_CONTENT_MAX_IDS = 50;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `?ids=a,b` → the distinct well-formed ids, capped. A malformed id would fail the uuid cast. */
export function parseContentIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!UUID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length === RECORDS_CONTENT_MAX_IDS) break;
  }
  return out;
}

export function recordsContentUrl(missionId: string, ids: readonly string[]): string {
  return `/api/missions/${encodeURIComponent(missionId)}/artifacts/content?ids=${ids.map(encodeURIComponent).join(',')}`;
}

/**
 * Fetch bodies for `ids`, in chunks of the cap. Resolves to `id → content`;
 * ids the server did not return are absent (not visible to this reader, or gone).
 */
export async function fetchRecordsContent(
  missionId: string,
  ids: readonly string[],
  fetcher: typeof fetch = fetch,
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (let i = 0; i < ids.length; i += RECORDS_CONTENT_MAX_IDS) {
    const chunk = ids.slice(i, i + RECORDS_CONTENT_MAX_IDS);
    const res = await fetcher(recordsContentUrl(missionId, chunk));
    if (!res.ok) throw new Error(`records content ${res.status}`);
    const body = (await res.json()) as { contents?: Record<string, string | null> };
    Object.assign(out, body.contents ?? {});
  }
  return out;
}
