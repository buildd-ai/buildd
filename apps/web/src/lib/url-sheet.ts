/**
 * A sheet opened by a query param (`/app/missions?new=1`) closes by dropping
 * that param, so a link, a redirect from the old page and the back button all
 * agree on whether it is open. Pure.
 */
export function hrefWithout(pathname: string, search: string, keys: readonly string[]): string {
  const q = new URLSearchParams(search);
  for (const k of keys) q.delete(k);
  const rest = q.toString();
  return rest ? `${pathname}?${rest}` : pathname;
}
