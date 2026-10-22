/**
 * The shell's Ask column (Navigation R-21): its open/collapsed cookie, read by
 * the protected layout and written by the chat canvas. Pure, and outside the
 * chat module so the layout can read it without reaching into chat.
 */

/**
 * Whether the docked Ask is open or collapsed, kept in a cookie so the server
 * layout reserves (or doesn't) the column on first paint: no reflow when the
 * client takes over.
 */
export const ASK_DOCK_COOKIE = 'buildd-ask-dock';

/** Open unless the person collapsed it. */
export function askDockOpenFromCookie(value: string | null | undefined): boolean {
  return value !== 'collapsed';
}

export function askDockCookie(open: boolean): string {
  return `${ASK_DOCK_COOKIE}=${open ? 'open' : 'collapsed'}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
