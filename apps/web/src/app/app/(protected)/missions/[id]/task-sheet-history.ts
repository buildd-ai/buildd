/**
 * History model for the task sheet over a mission
 * (docs/design/mission-feed-mobile-continuity.md, "Interaction, URL and scroll
 * model", W5).
 *
 * | Action                  | Call                           | Back does        |
 * |-------------------------|--------------------------------|------------------|
 * | open a task (closed)    | pushState(?task=Y)             | closes the sheet |
 * | open a task (open)      | replaceState(?task=Z)          | closes the sheet |
 * | ‹ › / Next needing you  | replaceState(?task=Z)          | closes the sheet |
 * | close, sheet was pushed | history.back()                 | —                |
 * | close, entered with it  | replaceState(no task, #t-Y)    | leaves mission   |
 *
 * Only native history calls — never `router.push`/`replace`/`refresh`. The App
 * Router syncs `useSearchParams` from them without an RSC fetch, provided the
 * written data does not carry Next's own markers (see `lib/native-history.ts`
 * and `TaskSheet.next-history.test.ts`).
 *
 * "Next needing you" and a row tap while a sheet is already open (docked md+)
 * also replace: the sheet is one entry however many tasks it visits, so one
 * Back always closes it.
 *
 * Whether the current entry was pushed by us is tracked in memory, not in
 * `history.state`: a router refresh rewrites the entry's state without the
 * caller's keys, so a marker there would silently vanish mid-session.
 *
 * Known limit, accepted: the memory dies with the component. Open a sheet
 * (push), tap "Open full page", press Back — the mission remounts on the sheet
 * entry, cannot tell it was pushed, and ✕ closes by replacing. That leaves the
 * closed entry from before the push behind it, so the next Back lands on the
 * same mission (without the focus hash) instead of leaving it. Nothing is lost
 * or broken, it costs one extra Back; a marker that survives remount but not a
 * router refresh would be worse than none. Pinned in task-sheet-history.test.ts.
 */
import { isValidTaskId } from '@/lib/task-id';
import { missionTaskAnchorId } from '@/lib/mission-task-href';
import { nativeHistoryData } from '@/lib/native-history';

export interface SheetLocation {
  pathname: string;
  search: string;
  hash: string;
}

export interface TaskSheetHistoryDeps {
  history: {
    readonly state: unknown;
    pushState(data: unknown, unused: string, url?: string | URL | null): void;
    replaceState(data: unknown, unused: string, url?: string | URL | null): void;
    back(): void;
  };
  location(): SheetLocation;
}

/** The valid task id in `?task=`, or null (malformed ids never open a sheet). */
export function readTaskParam(search: string): string | null {
  const id = new URLSearchParams(search).get('task');
  return isValidTaskId(id) ? id : null;
}

/** The mission URL with the sheet open on `taskId`. Any `#t-` focus hash is dropped. */
export function sheetUrl(loc: SheetLocation, taskId: string): string {
  const params = new URLSearchParams(loc.search);
  params.set('task', taskId);
  return `${loc.pathname}?${params.toString()}`;
}

/** The mission URL with the sheet closed and focus landed on `taskId`'s row. */
export function closedSheetUrl(loc: SheetLocation, taskId: string): string {
  const params = new URLSearchParams(loc.search);
  params.delete('task');
  const qs = params.toString();
  return `${loc.pathname}${qs ? `?${qs}` : ''}#${missionTaskAnchorId(encodeURIComponent(taskId))}`;
}

export interface TaskSheetHistory {
  open(taskId: string): void;
  step(taskId: string): void;
  close(taskId: string): void;
  /** Call on every `popstate` (Back / Forward). */
  onPopState(): void;
}

export function createTaskSheetHistory(deps: TaskSheetHistoryDeps): TaskSheetHistory {
  const hasTask = () => readTaskParam(deps.location().search) !== null;
  // True when the current entry is a sheet entry sitting on top of a closed one.
  let pushed = false;
  let open = hasTask();

  const write = (op: 'pushState' | 'replaceState', url: string) =>
    deps.history[op](nativeHistoryData(deps.history.state), '', url);

  return {
    open(taskId) {
      if (open) {
        write('replaceState', sheetUrl(deps.location(), taskId));
      } else {
        write('pushState', sheetUrl(deps.location(), taskId));
        pushed = true;
      }
      open = true;
    },
    step(taskId) {
      write('replaceState', sheetUrl(deps.location(), taskId));
      open = true;
    },
    close(taskId) {
      open = false;
      if (pushed) {
        pushed = false;
        deps.history.back();
      } else {
        write('replaceState', closedSheetUrl(deps.location(), taskId));
      }
    },
    onPopState() {
      const now = hasTask();
      // Arriving on a sheet entry from a closed one (Forward) means the entry
      // behind it is closed — Back is the right close. Leaving a sheet entry
      // (Back) means no entry of ours is on top any more.
      if (now && !open) pushed = true;
      if (!now) pushed = false;
      open = now;
    },
  };
}

export interface TaskClickLike {
  target: EventTarget | null;
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** The slice of a DOM element the resolver walks. */
export interface ClickNode {
  tagName: string;
  parentElement: ClickNode | null;
  getAttribute(name: string): string | null;
}

const CONTROL_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'LABEL']);

function isControl(n: ClickNode): boolean {
  const tag = n.tagName.toUpperCase();
  if (CONTROL_TAGS.has(tag)) return true;
  if (tag === 'A' && n.getAttribute('href') !== null) return true;
  return n.getAttribute('role') === 'button';
}

/** A link that means "this task" — its full page or its sheet — and so opens the sheet instead. */
function isOwnTaskLink(n: ClickNode, taskId: string): boolean {
  const href = n.getAttribute('href');
  if (!href) return false;
  let url: URL;
  try {
    url = new URL(href, 'https://x.invalid');
  } catch {
    return false;
  }
  if (url.pathname === `/app/tasks/${taskId}`) return true;
  return url.pathname.startsWith('/app/missions/') && url.searchParams.get('task') === taskId;
}

/**
 * The task a click should open in the sheet, or null to let it through.
 *
 * - A tap anywhere on a `data-task-id` row opens it — including a completed
 *   task with no PR. `data-task-actionable` is no longer an opt-out (AC-10).
 * - The row's own links (its `?task=` href, or a legacy title `<Link>` to
 *   `/app/tasks/<id>`) open the sheet too, so every row taps the same way.
 *   Any other control inside a row (a PR link, retry, an attempts disclosure)
 *   keeps its own behaviour.
 * - Modified or non-primary clicks keep the link's own behaviour (new tab).
 * - Pulse segments are not rows: the pulse focuses first and opens on a second
 *   tap through the focus store, so the delegated handler leaves them alone.
 *
 * Run it in the CAPTURE phase: a Next `<Link>` navigates in its own onClick,
 * before a bubbling handler could stop it.
 */
export function resolveTaskOpen(e: TaskClickLike): string | null {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return null;
  const start = e.target as unknown as Partial<ClickNode> | null;
  if (!start || typeof start.getAttribute !== 'function' || typeof start.tagName !== 'string') return null;

  let control: ClickNode | null = null;
  for (let n: ClickNode | null = start as ClickNode; n; n = n.parentElement) {
    const testid = n.getAttribute('data-testid');
    if (testid === 'mission-pulse' || testid === 'mission-pulse-segment') return null;
    const id = n.getAttribute('data-task-id');
    if (id !== null) {
      if (!isValidTaskId(id)) return null;
      // The row element itself may be the link (MissionTaskRow's <a>).
      if (control && control !== n && !isOwnTaskLink(control, id)) return null;
      return id;
    }
    if (!control && isControl(n)) control = n;
  }
  return null;
}
