export const INBOX_PAGE_SIZE = 10;

/** How many rows to show: `?shown=` rounded to a page, clamped to [page, total]. */
export function inboxShownCount(raw: string | string[] | undefined, total: number): number {
  const v = Number.parseInt(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '', 10);
  const want = Number.isFinite(v) && v > INBOX_PAGE_SIZE ? v : INBOX_PAGE_SIZE;
  return Math.min(want, total);
}
