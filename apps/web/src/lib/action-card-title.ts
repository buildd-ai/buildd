/**
 * Display-only short form of a generated task title, for Needs-You cards.
 *
 * Two platform-generated shapes read as boilerplate on a card whose chip
 * already says what kind of item it is:
 *   - `chore(mission): merge <trunk> into the <X> integration branch`
 *     (mission-branch-refresh.ts) → `Refresh <X> from <trunk>`
 *   - `Ship mission: <X>` (MISSION_PR_TASK_PREFIX) → `Ship <X>`
 *
 * Everything else is returned unchanged — a conventional-commit type on a
 * human or agent title (`fix:` vs `feat:`) is information, not noise. The full
 * title stays the card's `title` attribute and the detail page's heading.
 */
const REFRESH = /^chore\(mission\): merge (\S+) into the (.+) integration branch$/;
const SHIP = /^((?:\[[^\]]*\]\s*)*)Ship mission:\s+(.+)$/;

export function actionCardTitle(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  const refresh = REFRESH.exec(t);
  if (refresh) return `Refresh ${refresh[2]} from ${refresh[1]}`;
  const ship = SHIP.exec(t);
  if (ship) return `${ship[1]}Ship ${ship[2]}`;
  return t;
}
