/**
 * Home's PR action sheet is opened by `?pr=<n>` (plus the alert's signed
 * `t`). Pure, so Home's sign-in redirect and the sheet agree on the URL.
 */

/** The query that opens the sheet; closing drops both. */
export const PR_SHEET_KEYS = ['pr', 't'] as const;

/** `?pr=` as a PR number, or null when it is not one. */
export function parsePrParam(raw: string | string[] | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Where a signed-out reader signs in so they land back on the open sheet. */
export function prSheetSignInHref(prNumber: number, token: string | undefined): string {
  const here = `/app/home?pr=${prNumber}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
  return `/app/auth/signin?callbackUrl=${encodeURIComponent(here)}`;
}
