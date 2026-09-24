'use client';

/**
 * MissionTaskRow: the one task row on the mission feed
 * (docs/design/mission-feed-mobile-continuity.md, "One task row").
 *
 * ```
 * │● ◆ Add claim lease column        #412↻ › │  status glyph, kind glyph, title, PR, ›
 * │    BUILD · running 4m · 2 rec            │  meta: phase · time/reason · records
 * ```
 *
 * - The whole row is a real `<a href="/app/missions/X?task=Y">`, so middle-click
 *   and long-press work; the sheet owner (S4) intercepts the click with a
 *   delegated handler on `data-task-id` and calls `pushState`.
 * - Status glyph first, from the row's pulse state. The PR `#N` colour follows
 *   the real PR state (`PR_STATE_TOKEN`), never a constant success green.
 * - Retries fold into the meta line as `↻ N` (D1): `done · 1 rec · ↻ 3`. The
 *   count is a disclosure button laid over the meta line, outside the link, that
 *   expands the attempts inline. An attempt is never a row of its own, and the
 *   count no longer costs a full-height line under every retried row.
 * - Inside a `MissionFocusProvider` the row registers itself (in-view, focus
 *   scroll) and reads its outline from the shared selection.
 */
import { useCallback, useState } from 'react';
import type { FeedRow } from '@/lib/mission-feed-groups';
import { PR_STATE_TOKEN, PULSE_STATE_GLYPH, PULSE_STATE_TOKEN, type MissionFeedTaskInput } from '@/lib/mission-pulse';
import { missionTaskAnchorId, missionTaskHref, taskPageHref, type MissionOrigin } from '@/lib/mission-task-href';
import { deriveWorkKind } from '@/lib/task-presentation';
import { PULSE_STATE_LABEL, PULSE_TOKEN_TEXT } from './MissionPulse';
import { useMissionFocusSnapshot, useMissionFocusStore } from './mission-focus-context';

/**
 * `scroll-margin-top` equal to `MISSION_MASTHEAD_FOLDED_PX`, so a focused row lands just
 * under the folded masthead. A literal for Tailwind's scanner; the test pins it to the token.
 */
export const MISSION_ROW_SCROLL_MARGIN_CLASS = 'scroll-mt-[84px]';

const ms = (d: Date | string | null | undefined) => (d == null ? NaN : new Date(d).getTime());

function age(fromMs: number, now: number): string | null {
  if (!Number.isFinite(fromMs)) return null;
  const mins = Math.max(0, Math.floor((now - fromMs) / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export interface TaskRowMetaOptions {
  now: number;
  /** The live current action (`MissionLiveStore`, S7), e.g. "editing lease.ts". */
  liveLine?: string | null;
  /** Review-worthy records this task produced. */
  recordsCount?: number;
  /** Title of `row.blockedByTaskId`, for "after <title>". */
  blockedByTitle?: string | null;
}

/**
 * The meta line: `phase · detail · N rec`. The detail follows the row's one
 * state — the needs-you reason first, then live work, then queued/blocked, then
 * the outcome.
 */
export function buildTaskRowMeta<T extends MissionFeedTaskInput>(row: FeedRow<T>, opts: TaskRowMetaOptions): string {
  const { now } = opts;
  const detail = (() => {
    switch (row.state) {
      case 'needs_you': {
        const since = age(row.askedAt ?? NaN, now);
        switch (row.needsYou) {
          case 'input': return since ? `asked ${since}` : 'asked';
          case 'question': return since ? `question ${since}` : 'question';
          case 'decision': return since ? `decision ${since}` : 'decision';
          case 'pr':
            return row.pr?.state === 'conflict' ? 'conflict'
              : row.pr?.state === 'ci_failed' ? 'CI failing'
              : 'ready to merge';
          case 'failed': return 'failed';
          default: return 'needs you';
        }
      }
      case 'moving': {
        if (row.task.status === 'completed' && row.pr?.state === 'checks_running') return 'checks running';
        const elapsed = age(ms(row.task.worker?.startedAt), now);
        if (opts.liveLine) return elapsed ? `${elapsed} · ${opts.liveLine}` : opts.liveLine;
        return elapsed ? `running ${elapsed}` : 'starting';
      }
      case 'queued':
        return row.blockedByTaskId && opts.blockedByTitle ? `after ${opts.blockedByTitle}` : 'queued';
      case 'failed': return 'failed';
      case 'skipped': return 'cancelled';
      case 'done': return 'done';
    }
  })();
  const records = opts.recordsCount && opts.recordsCount > 0 ? `${opts.recordsCount} rec` : null;
  return [row.position.phaseLabel, detail, records].filter(Boolean).join(' · ');
}

export interface MissionTaskRowProps<T extends MissionFeedTaskInput = MissionFeedTaskInput> {
  row: FeedRow<T>;
  missionId: string;
  from?: MissionOrigin | null;
  initiativeId?: string | null;
  /**
   * Clock for elapsed/age text. Required: a `Date.now()` default would differ
   * between the server render and hydration at minute boundaries. Pass the
   * server render time (and tick it on the client if the row should age).
   */
  now: number;
  liveLine?: string | null;
  recordsCount?: number;
  blockedByTitle?: string | null;
  /** Outline override. Inside a provider the shared selection decides. */
  focused?: boolean;
  className?: string;
}

export default function MissionTaskRow<T extends MissionFeedTaskInput>({
  row,
  missionId,
  from,
  initiativeId,
  now,
  liveLine,
  recordsCount,
  blockedByTitle,
  focused: focusedProp,
  className = '',
}: MissionTaskRowProps<T>) {
  const store = useMissionFocusStore();
  const focus = useMissionFocusSnapshot();
  const { taskId, task } = row;
  const focused = focusedProp ?? focus?.outlinedTaskId === taskId;

  const ref = useCallback(
    (el: HTMLAnchorElement | null) => {
      if (!store || !el) return;
      store.registerRow(taskId, el);
      return () => store.unregisterRow(taskId);
    },
    [store, taskId],
  );

  const token = PULSE_STATE_TOKEN[row.state];
  const kind = deriveWorkKind({ kind: task.kind, roleSlug: task.roleSlug });
  const meta = buildTaskRowMeta(row, { now, liveLine, recordsCount, blockedByTitle });
  const href = missionTaskHref({ missionId, taskId, from, initiativeId, mode: 'sheet' });
  const attempts = row.attempts;
  const [attemptsOpen, setAttemptsOpen] = useState(false);
  const attemptsListId = `${missionTaskAnchorId(taskId)}-attempts`;
  const attemptsLabel = attempts.length > 0 ? `${meta ? ' · ' : ''}↻ ${attempts.length}` : null;

  return (
    <div className={className}>
      <div className="relative">
        <a
          ref={ref}
          href={href}
          id={missionTaskAnchorId(taskId)}
          data-testid="mission-task-row"
          data-task-id={taskId}
          data-status={row.state}
          data-focused={String(focused)}
          className={`${MISSION_ROW_SCROLL_MARGIN_CLASS} flex min-h-[52px] flex-col justify-center gap-0.5 border-b border-border-default px-3 py-1.5 transition-[outline-color] duration-500 hover:bg-surface-2 ${
            focused ? 'outline outline-2 -outline-offset-2 outline-accent' : 'outline-transparent'
          }`}
        >
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span
              data-testid="mission-task-row-status"
              aria-hidden="true"
              className={`w-3 shrink-0 text-center font-mono text-[12px] leading-none ${PULSE_TOKEN_TEXT[token]}`}
            >
              {PULSE_STATE_GLYPH[row.state]}
            </span>
            <span
              data-testid="mission-task-row-kind"
              aria-hidden="true"
              title={kind?.label}
              className="w-3 shrink-0 text-center text-[11px] leading-none text-text-secondary"
            >
              {kind?.glyph ?? ''}
            </span>
            <span className="sr-only">{`${PULSE_STATE_LABEL[row.state]}: `}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium text-text-primary">{task.title}</span>
            {row.pr && (
              <span
                data-testid="mission-task-row-pr"
                data-pr-state={row.pr.state}
                className={`shrink-0 font-mono text-[11px] ${PULSE_TOKEN_TEXT[PR_STATE_TOKEN[row.pr.state]]}`}
              >
                {`#${row.pr.number}${row.pr.state === 'checks_running' ? '↻' : ''}`}
              </span>
            )}
            <span aria-hidden="true" className="shrink-0 font-mono text-[13px] text-text-muted">›</span>
          </span>
          {(meta || attemptsLabel) && (
            <span className="flex h-4 min-w-0 pl-[2.5rem] font-mono text-[11px] leading-4 text-text-muted">
              <span className="min-w-0 truncate">{meta}</span>
              {/* The visible `· ↻ N`, inside the link so it moves with the row
                  (FLIP). The button over it announces it, so it is aria-hidden here. */}
              {attemptsLabel && <span aria-hidden="true" className="shrink-0 whitespace-pre">{attemptsLabel}</span>}
            </span>
          )}
        </a>
        {attempts.length > 0 && (
          /*
           * The toggle, laid over the meta line. The link cannot hold a button
           * (nested interactive content), so the overlay repeats the meta text
           * invisibly with the same padding and truncation: the button then lands
           * exactly on `· ↻ N`. The overlay ignores pointers except on the button.
           * The button's hit area is 44px tall, anchored to the row's bottom edge
           * so it never reaches into the next row; it can overlap the title just
           * above the count, where a mis-tap only unfolds the attempts.
           */
          <div className="pointer-events-none absolute inset-0 flex items-end pb-[7px] pl-[3.25rem] pr-3">
            <span aria-hidden="true" className="invisible min-w-0 truncate font-mono text-[11px] leading-4">{meta}</span>
            <button
              type="button"
              data-testid="mission-task-attempts"
              aria-expanded={attemptsOpen}
              aria-controls={attemptsListId}
              aria-label={`${attempts.length} attempt${attempts.length === 1 ? '' : 's'}`}
              onClick={() => setAttemptsOpen(v => !v)}
              className="pointer-events-auto relative h-4 shrink-0 whitespace-pre font-mono text-[11px] leading-4 text-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <span
                data-testid="mission-task-attempts-hit"
                aria-hidden="true"
                className="absolute -bottom-[7px] left-1/2 min-h-11 min-w-11 w-[calc(100%+12px)] -translate-x-1/2"
              />
              {attemptsLabel}
            </button>
          </div>
        )}
      </div>
      {attempts.length > 0 && attemptsOpen && (
        <ul
          id={attemptsListId}
          data-testid="mission-task-attempts-list"
          className="border-b border-border-default pb-1 pl-[2.75rem] pr-3"
        >
          {attempts.map(a => (
            <li key={a.id}>
              <a
                href={taskPageHref({ taskId: a.id, missionId })}
                className="flex min-h-11 items-center gap-2 font-mono text-[11px] text-text-secondary hover:text-text-primary"
              >
                <span className="shrink-0 text-text-muted">{a.status}</span>
                <span className="min-w-0 truncate">{a.title}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
