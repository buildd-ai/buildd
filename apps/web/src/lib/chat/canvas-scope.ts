/**
 * The summoned chat canvas (docs/design/chat-canvas.md, step 2): what it's
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

/**
 * Below 768px the canvas takes over the screen (a full-height sheet: the page
 * behind is out of reach anyway). From 768px it peeks: a panel anchored right
 * over a flat dim, the page still readable beside it.
 */
export function canvasPresentation(viewportWidth: number): 'takeover' | 'peek' {
  return viewportWidth < 768 ? 'takeover' : 'peek';
}

/** ⌘K / Ctrl+K toggles the canvas, from anywhere, including a text field. */
export function isCanvasToggle(e: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean }): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || e.repeat) return false;
  return !!(e.metaKey || e.ctrlKey);
}
