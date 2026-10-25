'use client';

/**
 * `?state=runner-row`: the shared RunnerRow in every state of spec 97b1bd0b
 * R-14 / R-15: working, idle, idle while work could start here, offline with a
 * saved slot change, and expanded (with and without the owner/admin stepper).
 */
import type { FleetSnapshot } from '@buildd/shared';
import type { RunnerHeartbeat } from '@/lib/runner-heartbeats-shared';
import { RunnerRow } from '../../(protected)/health/_components/RunnerRow';

const NOW = Date.parse('2026-10-25T12:00:00Z');
type Fleet = FleetSnapshot['runners'][number];

const hb = (id: string, over: Partial<RunnerHeartbeat> = {}): RunnerHeartbeat => ({
  id,
  accountName: id,
  lastHeartbeatAt: new Date(NOW - 8_000).toISOString(),
  maxConcurrentWorkers: 4,
  activeWorkerCount: 0,
  runnerClass: 'personal',
  mine: true,
  ...over,
} as RunnerHeartbeat);

const fleet = (id: string, online: boolean, busy: number): Fleet => ({
  id, name: id, machine: null, maxSlots: 4, online,
  slots: [0, 1, 2, 3].map(i => i < busy
    ? { index: i, worker: { label: 'task', name: 'Wire the Health page', mine: true }, last: null }
    : { index: i, worker: null, last: i === 3 ? { label: 'Earlier run', failed: true, at: NOW - 7_200_000, mine: true } : null }),
} as unknown as Fleet);

const canEdit = { desired: null, origin: null, setBy: null, setAt: null, canEdit: true } as never;
const saved = { desired: 6, origin: 'dashboard', setBy: 'Max', setAt: new Date(NOW - 60_000).toISOString(), canEdit: true } as never;

const CASES: { label: string; props: Partial<Parameters<typeof RunnerRow>[0]> & { runner: RunnerHeartbeat } }[] = [
  { label: 'Working', props: { runner: hb('studio-working', { activeWorkerCount: 2 }) } },
  { label: 'Idle', props: { runner: hb('studio-idle') } },
  { label: 'Idle while work could start here', props: { runner: hb('studio-idle-queue'), workQueuedHere: 3 } },
  { label: 'Offline, slot change saved', props: { runner: hb('studio-offline', { lastHeartbeatAt: new Date(NOW - 3_600_000).toISOString(), slots: saved }), online: false } },
  { label: 'Expanded, owner or admin', props: { runner: hb('studio-expanded', { activeWorkerCount: 2, slots: canEdit }), health: { loading: false, expanded: true } } },
  { label: 'Expanded, read only', props: { runner: hb('studio-readonly', { activeWorkerCount: 1 }), health: { loading: false, expanded: true } } },
];

export default function RunnerRowFixture() {
  return (
    <main className="min-h-screen p-4 space-y-6 max-w-xl">
      {CASES.map(c => {
        const id = c.props.runner.id;
        const online = c.props.online ?? true;
        return (
          <section key={c.label} data-testid="fixture-runner-row">
            <p className="text-meta text-text-muted mb-1">{c.label}</p>
            <div className="border-y border-border-default">
              <RunnerRow fleetRow={fleet(id, online, c.props.runner.activeWorkerCount)} online={online} now={NOW} seesTeamWork {...c.props} />
            </div>
          </section>
        );
      })}
    </main>
  );
}
