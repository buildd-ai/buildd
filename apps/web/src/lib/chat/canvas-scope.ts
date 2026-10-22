/**
 * The summoned chat canvas (knowledge-base: buildd/design/chat-canvas.md, step 2): what it's
 * about on the current page, where the floating Ask button shows, how it
 * presents, and the shortcut that toggles it. Pure.
 */
import { isUuid } from '@/lib/uuid';
import type { ChatAbout } from './entry-points';

export interface CanvasScope {
  /** The page's object, sent as `entry.about` with every turn. */
  about: ChatAbout | null;
  /** The page's workspace, when the page is one. */
  workspaceId: string | null;
  /**
   * Steering one running worker instead of talking with an agent (Board
   * tiles, the tasks list, home's fleet slot — "Steer"). Mutually exclusive
   * with `about`: never set by `canvasScopeFromPath`, only by `openSteer`.
   */
  steer: { taskId: string } | null;
}

const NONE: CanvasScope = { about: null, workspaceId: null, steer: null };

export function canvasScopeFromPath(pathname: string | null | undefined): CanvasScope {
  if (!pathname) return NONE;
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== 'app') return NONE;
  const [, section, id] = seg;
  if ((section === 'missions' || section === 'tasks') && id && isUuid(id)) {
    return { about: { kind: section === 'missions' ? 'mission' : 'task', id }, workspaceId: null, steer: null };
  }
  if (section === 'workspaces' && id && isUuid(id)) return { about: null, workspaceId: id, steer: null };
  if (section === 'settings' && seg[2] === 'workspace' && seg[3] && isUuid(seg[3])) return { about: null, workspaceId: seg[3], steer: null };
  return NONE;
}

/** The floating Ask button: every app page but chat itself, when chat is available. */
export function showsAskButton(pathname: string | null | undefined, chatAvailable: boolean): boolean {
  if (!chatAvailable || !pathname) return false;
  return !(pathname === '/app/chat' || pathname.startsWith('/app/chat/'));
}

/** From this width Ask docks as a column beside the page (Navigation R-21). */
export const CANVAS_DOCK_MIN_WIDTH = 1440;
export const CANVAS_DOCK_QUERY = `(min-width: ${CANVAS_DOCK_MIN_WIDTH}px)`;
export const CANVAS_PEEK_QUERY = '(min-width: 768px)';

export type CanvasPresentation = 'takeover' | 'peek' | 'docked';

/**
 * Below 768px the canvas takes over the screen (a full-height sheet: the page
 * behind is out of reach anyway). From 768px it peeks: a panel anchored right
 * over a flat dim, the page still readable beside it. From 1440px it docks: a
 * column of the shell, no dim, the page reflowing beside it.
 */
export function canvasPresentation(viewportWidth: number): CanvasPresentation {
  if (viewportWidth < 768) return 'takeover';
  return viewportWidth < CANVAS_DOCK_MIN_WIDTH ? 'peek' : 'docked';
}

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

/** ⌘K / Ctrl+K toggles the canvas, from anywhere, including a text field. */
export function isCanvasToggle(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || e.repeat) return false;
  return !!(e.metaKey || e.ctrlKey);
}
