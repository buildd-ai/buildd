'use client';

/**
 * `?state=interactive-sessions`: Activity's Interactive sessions section with
 * one session in each state (working, online, offline, ended) across the three
 * clients. Illustrative data only.
 */
import { useEffect, useState } from 'react';
import InteractiveSessions from '@/app/app/(protected)/tasks/InteractiveSessions';
import type { LocalSessionView } from '@/lib/local-session-view';

export function interactiveSessionsFixture(now: number): LocalSessionView[] {
  const at = (minsAgo: number) => new Date(now - minsAgo * 60_000).toISOString();
  const base = { workspaceId: 'ws-fixture', clientVersion: null, interactive: true, startedAt: at(90), endedAt: null, task: null, workerId: null, workerLive: false, tasks: [] };
  return [
    { ...base, id: 's-working', client: 'claude', clientLabel: 'Claude Code', repo: 'acme/storefront', state: 'bound', lastSeenAt: at(0),
      task: { id: 'fixture-task-3', title: 'Cache the shipping quote', status: 'in_progress' }, workerId: 'w-3', workerLive: true,
      // A session whose subagents each claimed a task holds both.
      tasks: [
        { id: 'fixture-task-1', title: 'Fix checkout total rounding', status: 'in_progress', workerId: 'w-1', live: true },
        { id: 'fixture-task-3', title: 'Cache the shipping quote', status: 'in_progress', workerId: 'w-3', live: true },
      ] },
    { ...base, id: 's-online', client: 'cursor', clientLabel: 'Cursor', repo: 'acme/storefront', state: 'online', lastSeenAt: at(3), clientVersion: '1.7.2' },
    { ...base, id: 's-offline', client: 'codex', clientLabel: 'Codex', repo: 'acme/api', state: 'offline', lastSeenAt: at(42) },
    { ...base, id: 's-ended', client: 'claude', clientLabel: 'Claude Code', repo: 'acme/api', state: 'ended', lastSeenAt: at(120), endedAt: at(120),
      task: { id: 'fixture-task-2', title: 'Add rate limit headers', status: 'completed' }, workerId: 'w-2',
      tasks: [{ id: 'fixture-task-2', title: 'Add rate limit headers', status: 'completed', workerId: 'w-2', live: false }] },
  ];
}

export default function InteractiveSessionsFixture() {
  // Built after mount so server and client render the same relative times.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  return (
    <div className="min-h-screen bg-surface-1 py-6">
      <div className="mx-auto max-w-3xl">
        {now != null && <InteractiveSessions sessions={interactiveSessionsFixture(now)} now={now} />}
      </div>
    </div>
  );
}
