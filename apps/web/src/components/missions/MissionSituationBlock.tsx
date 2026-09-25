/**
 * The mission situation, rendered.
 *
 * Two components, one derivation. `MissionSituationBlock` is the mission
 * header's above-fold block; `MissionSituationLine` is the same sentence as a
 * card subtitle. Neither builds the sentence — both render
 * `MissionStateView.situation`, which the accessor produced. That is the whole
 * point of Part 3 of the task this closes: a card and a header that phrase the
 * same state differently are two owners for one answer.
 *
 * What the block shows, in the order a reader needs it:
 *
 * 1. The SITUATION — what the mission is doing and what it is waiting on, in
 *    plain language.
 * 2. ONE primary affordance, wired to the thing that actually advances the
 *    mission. Not a menu. Everything a mission merely *supports* — Disarm, Edit
 *    schedule, Complete, Delete, Plan now — is a capability, and capabilities
 *    live behind a disclosure.
 * 3. The WHY, one line, with its hard ref linked: the top of `explain`'s
 *    `because[]` chain, which carries a PR number, a task id or a criterion
 *    label rather than prose.
 * 4. Anything else outstanding, demoted to a quiet list — present because the
 *    precedence verdict is allowed to rank facts, not to erase them.
 *
 * When nothing is outstanding it says so and renders no action at all. Falling
 * back to the button wall in the quiet case is what made the screen unreadable
 * in the first place.
 */
import Link from 'next/link';
import type { CausalLink } from '@/lib/explain-types';
import { situationDetail, type MissionSituation, type WaitingOnDescriptor, type WaitingOnTone } from '@/lib/mission-state-view';
import { missionTaskHref } from '@/lib/mission-task-href';

/**
 * The element the criteria affordance targets: the Verified pill in the
 * mission masthead, which opens the goal-criteria sheet on this hash.
 */
export const MISSION_CRITERIA_ANCHOR = 'mission-criteria';

const TONE_BLOCK_CLASS: Record<WaitingOnTone, string> = {
  neutral: 'border-border-default bg-surface-3/40',
  info: 'border-status-info/30 bg-status-info/5',
  warning: 'border-status-warning/30 bg-status-warning/5',
  error: 'border-status-error/30 bg-status-error/5',
};

const TONE_TEXT_CLASS: Record<WaitingOnTone, string> = {
  neutral: 'text-text-muted',
  info: 'text-status-info',
  warning: 'text-status-warning',
  error: 'text-status-error',
};

/** How the primary affordance is performed. */
export type PrimaryAffordance =
  /** Leaves the app — a PR on the forge. */
  | { kind: 'external'; label: string; href: string }
  /**
   * Somewhere else in the dashboard, or an anchor on this page. `taskId` is set
   * when the destination is one of this mission's tasks: the link carries
   * `data-task-id`, so the task sheet opens over the mission instead of a push.
   */
  | { kind: 'internal'; label: string; href: string; taskId?: string }
  /** Nothing is wired for this blocker; the sentence carries it alone. */
  | null;

/**
 * Map the blocker to the affordance that clears it.
 *
 * Only blockers with a real destination get one. A button that merely scrolls
 * somewhere vague is the button wall again, so `null` is a legitimate answer and
 * the situation sentence stands by itself.
 */
export function affordanceFor(
  focus: WaitingOnDescriptor | null,
  ctx: {
    missionId: string;
    /**
     * False when the page renders no `#mission-criteria` target (the Verified
     * pill is hidden on a terminal mission whose criteria do not pass): a link
     * to nothing is worse than the sentence alone. Default true.
     */
    criteriaReachable?: boolean;
  },
): PrimaryAffordance {
  if (!focus) return null;
  switch (focus.kind) {
    case 'merge': {
      const href = focus.prUrls[0];
      if (!href) return null;
      const label = focus.missionPr
        ? focus.prNumbers[0] != null ? `Merge the mission PR #${focus.prNumbers[0]}` : 'Merge the mission PR'
        : focus.count === 1 ? 'Review and merge the open PR' : `Review ${focus.count} open PRs`;
      return { kind: 'external', label, href };
    }
    case 'criterion_failing':
    case 'criterion_unverified':
      if (ctx.criteriaReachable === false) return null;
      return { kind: 'internal', label: 'Go to goal criteria', href: `#${MISSION_CRITERIA_ANCHOR}` };
    case 'task_failed':
      return taskAffordance('Open the failed task', focus.taskIds[0], ctx.missionId);
    case 'claim_deferral':
      return taskAffordance('Open the deferred task', focus.taskIds[0], ctx.missionId);
    case 'task':
      return taskAffordance('Open the blocking task', focus.taskIds[0], ctx.missionId);
    case 'dependency':
      return { kind: 'internal', label: 'Open the upstream mission', href: `/app/missions/${focus.missionId}` };
    case 'human_decision':
    case 'self_resolving_wait':
      return null;
  }
}

function taskAffordance(label: string, taskId: string | undefined, missionId: string): PrimaryAffordance {
  if (!taskId) return null;
  return { kind: 'internal', label, href: missionTaskHref({ missionId, taskId, mode: 'sheet' }), taskId };
}

/** Render a causal link's hard ref as something clickable. Prose is never a ref. */
function RefLink({ refs, missionId }: { refs: CausalLink['refs']; missionId: string }) {
  if (refs.prUrl) {
    return (
      <a
        href={refs.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="font-mono text-accent-text hover:underline"
      >
        {refs.prNumber != null ? `#${refs.prNumber}` : 'PR'}
      </a>
    );
  }
  if (refs.taskId) {
    return (
      <Link
        href={missionTaskHref({ missionId, taskId: refs.taskId, mode: 'sheet' })}
        data-task-id={refs.taskId}
        className="font-mono text-accent-text hover:underline"
      >
        task {refs.taskId.slice(0, 8)}
      </Link>
    );
  }
  if (refs.criterion) {
    return <span className="font-mono text-text-secondary">{refs.criterion}</span>;
  }
  if (refs.prNumber != null) {
    return <span className="font-mono text-text-secondary">#{refs.prNumber}</span>;
  }
  return null;
}

export interface MissionSituationBlockProps {
  missionId: string;
  situation: MissionSituation;
  /**
   * `explain`'s causal chain for this mission. Only the first link is rendered
   * — the one-line why. The rest is the Feed's job.
   */
  because: CausalLink[];
  /** False when the page renders no criteria target; see `affordanceFor`. */
  criteriaReachable?: boolean;
}

export default function MissionSituationBlock({ missionId, situation, because, criteriaReachable }: MissionSituationBlockProps) {
  const affordance = affordanceFor(situation.focus, { missionId, criteriaReachable });
  // One explanatory line (F2): the blockers, the next action, or the why.
  const detail = situationDetail(situation, because);

  return (
    <div
      data-testid="mission-situation"
      // Provenance is for diagnostics, not for the reader: it names the
      // derivation (`mission-state-view.ts`), which is noise on the page.
      data-derived-from={situation.derivedFrom}
      className={`mb-3 border px-3 py-2.5 ${TONE_BLOCK_CLASS[situation.tone]}`}
    >
      <p
        data-testid="mission-situation-headline"
        className="text-[13px] font-medium text-text-primary leading-snug"
      >
        {situation.headline}
      </p>

      {detail?.kind === 'why' && (
        <p className="mt-1 text-[12px] text-text-secondary leading-snug">
          {detail.link.claim} <RefLink refs={detail.link.refs} missionId={missionId} />
        </p>
      )}
      {detail?.kind === 'text' && (
        <p className="mt-1 text-[12px] text-text-secondary leading-snug">{detail.text}</p>
      )}
      {detail?.kind === 'blockers' && (
        <ul data-testid="mission-situation-blockers" className="mt-1 text-[12px] leading-snug">
          {detail.items.map(b => (
            <li key={b.taskId}>
              <Link
                href={missionTaskHref({ missionId, taskId: b.taskId, mode: 'sheet' })}
                data-task-id={b.taskId}
                className="inline-flex min-h-11 md:min-h-0 items-center gap-1.5 text-accent-text hover:underline"
              >
                <span className="truncate">{b.title}</span>
                <span className="shrink-0 font-mono text-text-muted">· {b.status}</span>
              </Link>
            </li>
          ))}
          {detail.more > 0 && <li className="text-text-muted">+{detail.more} more</li>}
        </ul>
      )}

      {affordance && (
        <div className="mt-2.5">
          {affordance.kind === 'external' ? (
            <a
              data-testid="mission-primary-action"
              href={affordance.href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 w-full md:w-auto items-center justify-center gap-2 px-5 py-2.5 bg-accent text-white font-mono text-[13px] font-semibold hover:bg-accent/90 transition-colors"
            >
              {affordance.label} →
            </a>
          ) : (
            <Link
              data-testid="mission-primary-action"
              href={affordance.href}
              data-task-id={affordance.taskId}
              className="inline-flex min-h-11 w-full md:w-auto items-center justify-center gap-2 px-5 py-2.5 bg-accent text-white font-mono text-[13px] font-semibold hover:bg-accent/90 transition-colors"
            >
              {affordance.label} →
            </Link>
          )}
        </div>
      )}

      {situation.alsoOutstanding.length > 0 && (
        <ul data-testid="mission-also-outstanding" className="mt-2.5 space-y-0.5">
          {situation.alsoOutstanding.map(fact => (
            <li key={fact.kind} className="text-[12px] leading-snug">
              <span className={`mr-1.5 ${TONE_TEXT_CLASS[fact.tone]}`}>·</span>
              <span className="text-text-secondary">{fact.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The card subtitle. Same sentence, no affordance, no chrome — a list row has
 * space for the statement and nothing else, and the statement is the part that
 * was missing.
 */
export function MissionSituationLine({ situation }: { situation: MissionSituation }) {
  return (
    <p
      data-testid="mission-situation-line"
      className={`text-[12px] leading-snug ${situation.tone === 'neutral' ? 'text-text-secondary' : TONE_TEXT_CLASS[situation.tone]}`}
    >
      {situation.headline}
    </p>
  );
}
