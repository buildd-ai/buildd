/**
 * The mission PR line on the mission page, and with delivery records
 * (docs/specs/workflow-kernel-library.md §6) the current delivery: a shipped
 * delivery is named beside it as a fact, never shown as the mission's verdict,
 * and recorded scope updates follow in one short line each. Pure: everything
 * comes from `deriveMissionIntegrationPr` and `describeScopeUpdates`.
 */
import { describeMissionDelivery, MISSION_PR_STATE_LABEL, type MissionIntegrationPrView } from '@/lib/mission-integration-pr';
import type { ScopeUpdateLine } from '@/lib/mission-scope-view';
import { missionTaskHref } from '@/lib/mission-task-href';

export function MissionPrLine({ pr }: { pr: MissionIntegrationPrView }) {
  const words = describeMissionDelivery(pr);
  return (
    <div data-testid="mission-pr-line" className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <p className="min-w-0 text-body text-text-secondary">
        <span title={pr.branch} className="font-semibold text-text-primary">{words.heading}</span>
        {/* With delivery records the sentence says the state; no chip competes with it. */}
        {!pr.delivery && (
          <span className={`ml-2 text-meta ${pr.state === 'merged' ? 'text-status-success' : pr.state === 'closed' ? 'text-status-error' : 'text-text-muted'}`}>
            {MISSION_PR_STATE_LABEL[pr.state]}
          </span>
        )}
        <span className="mt-0.5 block">{words.line}</span>
        {words.earlier && (
          <span data-testid="mission-shipped-deliveries" className="mt-0.5 block text-meta text-text-muted">{words.earlier}</span>
        )}
      </p>
      {pr.prUrl && (
        <a href={pr.prUrl} target="_blank" rel="noopener noreferrer" className="shrink-0 font-mono text-meta text-text-secondary hover:text-text-primary">
          #{pr.prNumber} →
        </a>
      )}
    </div>
  );
}

export function MissionScopeUpdates({ lines, missionId }: { lines: ScopeUpdateLine[]; missionId: string }) {
  if (lines.length === 0) return null;
  return (
    <ul data-testid="mission-scope-updates" className="space-y-0.5 text-meta text-text-secondary">
      {lines.map((u) => (
        <li key={u.key} className={u.needsDecision ? 'text-text-primary' : undefined}>
          {u.taskId ? <a href={missionTaskHref({ missionId, taskId: u.taskId })} className="hover:text-text-primary">{u.text}</a> : u.text}
        </li>
      ))}
    </ul>
  );
}
