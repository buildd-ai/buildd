'use client';

/**
 * `?state=mission-check-ins`: the mission Settings sheet's Check-ins,
 * Organizer runs (open, one row per trigger), Organizer checklist and Quiet
 * hours, with fixture data. The real page keeps these inside a closed sheet,
 * so a route screenshot never reaches them.
 */
import { useEffect, useState } from 'react';
import { describeLastCheck, selectOrganizerRuns, type LastCheck, type OrganizerRun } from '@/lib/mission-checkins';
import MissionCheckIns from '../../(protected)/missions/[id]/MissionCheckIns';
import HeartbeatStatusBadge from '../../(protected)/missions/[id]/HeartbeatStatusBadge';
import HeartbeatTimeline from '../../(protected)/missions/[id]/HeartbeatTimeline';
import HeartbeatChecklistEditor from '../../(protected)/missions/[id]/HeartbeatChecklistEditor';
import QuietHoursConfig from '../../(protected)/missions/[id]/QuietHoursConfig';
import MissionMonitoringToggle from '../../(protected)/missions/[id]/MissionMonitoringToggle';

const TRIGGERS = [
  'event', 'event', 'wake:dependency_met', 'wake:resumed', 'wake:budget_raised', 'wake:pr_merged',
  'wake:owner_note', 'wake:owner_answer', 'backstop', 'manual', 'cron', 'auto_retry', null,
] as const;

function build(now: number) {
  const iso = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const tasks = [
    { id: 'build-1', mode: 'execution', title: 'Add the export button to the report page', createdAt: iso(200), status: 'completed', context: null },
    ...TRIGGERS.map((t, i) => ({
      id: `run-${i}`,
      mode: 'planning',
      title: 'Mission: Example mission',
      createdAt: iso(10 + i * 45),
      status: i === 0 ? 'in_progress' : i === 5 ? 'failed' : 'completed',
      context: t ? { triggerSource: t, ...(i === 0 ? { triggerTaskId: 'build-1' } : {}) } : null,
    })),
  ];
  const results: Record<string, unknown> = {
    'run-1': { structuredOutput: { status: 'action_taken', summary: 'Filed the next two build tasks' } },
    'run-2': { structuredOutput: { status: 'ok', summary: 'Nothing to plan yet' } },
    'run-8': { structuredOutput: { status: 'action_taken', summary: 'Re-planned after the mission sat idle' } },
  };
  const runs = selectOrganizerRuns(tasks).map(r => ({ ...r, result: results[r.id] ?? null }));
  const checks: Array<{ caption: string; check: LastCheck }> = [
    { caption: 'heartbeat_not_stuck', check: describeLastCheck({ lastDeferralReason: 'heartbeat_not_stuck', lastDeferredAt: iso(12), lastRunAt: iso(12), isOverdue: false, latestOrganizerRun: null }) },
    { caption: 'backstop dispatch', check: describeLastCheck({ lastDeferralReason: null, lastDeferredAt: null, lastRunAt: iso(40), isOverdue: false, latestOrganizerRun: { triggerSource: 'backstop', createdAt: iso(39) } }) },
    { caption: 'heartbeat_criteria_blocked', check: describeLastCheck({ lastDeferralReason: 'heartbeat_criteria_blocked', lastDeferredAt: iso(5), lastRunAt: iso(5), isOverdue: false, latestOrganizerRun: null }) },
    { caption: 'overdue', check: describeLastCheck({ lastDeferralReason: null, lastDeferredAt: null, lastRunAt: iso(300), isOverdue: true, latestOrganizerRun: null }) },
  ];
  return { runs, checks };
}

export default function MissionCheckInsFixture() {
  // Built after mount: relative times read the real now, so server and client render alike.
  const [data, setData] = useState<{ runs: Array<OrganizerRun & { result: unknown }>; checks: Array<{ caption: string; check: LastCheck }> } | null>(null);
  useEffect(() => setData(build(Date.now())), []);
  if (!data) return null;
  return (
    <div className="min-h-screen bg-surface-1 px-4 py-6 md:px-8">
      <div className="mx-auto flex max-w-xl flex-col gap-5">
        <h1 className="text-lg font-semibold text-text-primary">Mission settings: check-ins</h1>
        <MissionMonitoringToggle
          missionId="fixture"
          initialStatus="active"
          hasSchedule
          schedule={{ nextRunAt: new Date(Date.now() + 20 * 60_000).toISOString(), lastRunAt: new Date(Date.now() - 40 * 60_000).toISOString() }}
          orchestrationMode="auto"
          isHeartbeat
        />
        <MissionCheckIns lastCheck={data.checks[0].check} />
        <section className="flex flex-col gap-2">
          <p className="font-mono text-xs text-text-secondary">Last check, by state</p>
          {data.checks.map(c => (
            <div key={c.caption} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-text-muted w-44 shrink-0">{c.caption}</span>
              <HeartbeatStatusBadge check={c.check} />
            </div>
          ))}
        </section>
        <HeartbeatTimeline runs={data.runs} defaultExpanded />
        <HeartbeatChecklistEditor missionId="fixture" checklist={null} />
        <QuietHoursConfig missionId="fixture" activeHoursStart={22} activeHoursEnd={7} activeHoursTimezone="UTC" />
      </div>
    </div>
  );
}
