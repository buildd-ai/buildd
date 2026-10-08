'use client';

/**
 * `?state=interactive-sessions`: where people's own coding sessions show.
 *
 * 1. Home's runner board with one runner and the "Your sessions" lane: the
 *    two tasks a working session holds right now, one row each.
 * 2. Activity's Interactive sessions section, collapsed: the working session
 *    (five tasks: three shown, "+2 more"), four sessions online with no task
 *    folded into one line, and earlier (offline and ended) ones folded under
 *    "N earlier sessions".
 *
 * Illustrative data only.
 */
import { useEffect, useState } from 'react';
import InteractiveSessions from '@/app/app/(protected)/tasks/InteractiveSessions';
import { FleetStrip } from '@/app/app/(protected)/home/FleetStrip';
import { buildFleetSnapshot } from '@/lib/fleet-view';
import type { LocalSessionView } from '@/lib/local-session-view';
import type { FleetSnapshot } from '@buildd/shared';

export function interactiveSessionsFixture(now: number): LocalSessionView[] {
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const base = { workspaceId: 'ws-fixture', clientVersion: null, interactive: true, startedAt: at(90), endedAt: null, task: null, workerId: null, workerLive: false, tasks: [] };
  const done = (id: string, title: string) => ({ id, title, status: 'completed', workerId: `w-${id}`, live: false });
  const idle = (i: number, client: 'claude' | 'cursor' | 'codex', label: string) => ({
    ...base, id: `s-online-${i}`, client, clientLabel: label, repo: 'acme/storefront', state: 'online' as const, lastSeenAt: at(i + 1),
  });
  return [
    { ...base, id: 's-working', client: 'claude', clientLabel: 'Claude Code', repo: 'acme/storefront', state: 'bound', lastSeenAt: at(0),
      task: { id: 'fixture-task-3', title: 'Cache the shipping quote', status: 'in_progress' }, workerId: 'w-3', workerLive: true,
      // A session whose subagents each claimed a task holds all of them.
      tasks: [
        done('fixture-task-10', 'Rename the invoice export'),
        done('fixture-task-11', 'Drop the unused currency table'),
        { id: 'fixture-task-1', title: 'Fix checkout total rounding', status: 'in_progress', workerId: 'w-1', live: true },
        done('fixture-task-12', 'Add a test for the refund webhook'),
        { id: 'fixture-task-3', title: 'Cache the shipping quote', status: 'in_progress', workerId: 'w-3', live: true },
      ] },
    idle(1, 'cursor', 'Cursor'),
    idle(2, 'claude', 'Claude Code'),
    idle(3, 'claude', 'Claude Code'),
    idle(4, 'codex', 'Codex'),
    { ...base, id: 's-offline', client: 'codex', clientLabel: 'Codex', repo: 'acme/api', state: 'offline', lastSeenAt: at(42) },
    { ...base, id: 's-ended', client: 'claude', clientLabel: 'Claude Code', repo: 'acme/api', state: 'ended', lastSeenAt: at(120), endedAt: at(120),
      task: { id: 'fixture-task-2', title: 'Add rate limit headers', status: 'completed' }, workerId: 'w-2',
      tasks: [done('fixture-task-2', 'Add rate limit headers')] },
    { ...base, id: 's-ended-2', client: 'claude', clientLabel: 'Claude Code', repo: 'acme/storefront', state: 'ended', lastSeenAt: at(300), endedAt: at(300) },
  ];
}

/** The runner board as Home draws it: one runner, plus the working session's two live tasks as their own lane. */
export function interactiveSessionsFleetFixture(now: number): FleetSnapshot {
  const ago = (m: number) => new Date(now - m * 60_000);
  const url = 'http://atlas.local:8766';
  return buildFleetSnapshot(
    [{ id: 'hb-atlas', accountId: 'acct', localUiUrl: url, maxConcurrentWorkers: 4, lastHeartbeatAt: ago(0) }],
    [
      { id: 'w-runner-1', accountId: 'acct', runner: url, localUiUrl: url, status: 'running', startedAt: ago(18), progress: 40,
        task: { id: 'fixture-task-20', title: 'feat(search): index product tags', roleSlug: 'builder', missionId: null } },
      { id: 'w-1', accountId: 'acct', runner: 'mcp', status: 'running', startedAt: ago(24), updatedAt: ago(1),
        task: { id: 'fixture-task-1', title: 'fix(checkout): total rounding', roleSlug: null, missionId: null } },
      { id: 'w-3', accountId: 'acct', runner: 'mcp', status: 'running', startedAt: ago(9), updatedAt: ago(0), progress: 60,
        task: { id: 'fixture-task-3', title: 'feat(shipping): cache the quote', roleSlug: null, missionId: null } },
    ],
    { now, sessionsOnline: 5 },
  );
}

export default function InteractiveSessionsFixture() {
  // Built after mount so server and client render the same relative times.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return (
    <div className="min-h-screen bg-surface-1 py-6">
      <div className="mx-auto max-w-5xl px-4">
        {now != null && <FleetStrip fleet={interactiveSessionsFleetFixture(now)} roles={[]} now={now} />}
      </div>
      <div className="mx-auto max-w-3xl">
        {now != null && <InteractiveSessions sessions={interactiveSessionsFixture(now)} now={now} />}
      </div>
    </div>
  );
}
