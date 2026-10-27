/**
 * Home's Agents panel and headline as data. Pure and client-safe.
 *
 * The squares are only ever now: one per slot, filled when busy, hatched
 * orange when waiting on a person, empty when free. The lines under them name
 * the work (task, mission, elapsed), never the runner or the role.
 */
import { readableRunName } from './run-name';
import type { FleetSnapshot } from '@buildd/shared';

export type AgentSquare = 'busy' | 'waiting' | 'free';

export interface AgentLine {
  key: string;
  taskId: string | null;
  /** The task's short name ("checkout"). */
  name: string;
  /** What it is doing, in a few words. */
  rest: string;
  missionId: string | null;
  mission: string | null;
  href: string | null;
  waiting: boolean;
  elapsedMs: number | null;
  /** Helper runs (checks, audit, final verification) running under this work. */
  checks: number;
}

export interface AgentsModel {
  busy: number;
  total: number;
  squares: AgentSquare[];
  lines: AgentLine[];
}

export function buildAgentsModel(fleet: FleetSnapshot, now: number, missionTitles: ReadonlyMap<string, string> = new Map(), taskHref: (w: { missionId: string | null; taskId: string }) => string = ({ taskId }) => `/app/tasks/${taskId}`): AgentsModel {
  const lines: AgentLine[] = [];
  const helpers: Array<{ taskId: string | null; hostTaskId: string | null; missionId: string | null; line: AgentLine }> = [];
  const squares: AgentSquare[] = [];
  for (const runner of fleet.runners) {
    if (!runner.online) continue;
    for (const slot of runner.slots) {
      const w = slot.worker;
      if (!w) { squares.push('free'); continue; }
      const waiting = w.question != null || w.status === 'waiting_input';
      squares.push(waiting ? 'waiting' : 'busy');
      const line: AgentLine = {
        key: w.workerId,
        taskId: w.taskId,
        // A friction or invariant task's label is a machine identifier
        // ("open_pr_outp pull_request 4191"): use its title in words instead.
        ...(/_/.test(`${w.label} ${w.rest}`)
          ? { name: readableRunName({ label: null, title: w.title ?? `${w.label} ${w.rest}` }), rest: '' }
          : { name: w.name ?? w.label, rest: w.name ? '' : w.rest }),
        missionId: w.missionId,
        mission: w.missionId ? missionTitles.get(w.missionId) ?? null : null,
        href: w.taskId ? taskHref({ missionId: w.missionId ?? null, taskId: w.taskId }) : null,
        waiting,
        elapsedMs: w.startedAt ? Math.max(0, now - new Date(w.startedAt).getTime()) : null,
        checks: 0,
      };
      if (w.helper) helpers.push({ taskId: w.taskId, hostTaskId: w.hostTaskId ?? null, missionId: w.missionId, line });
      else lines.push(line);
    }
  }
  // Helper runs are counted under the work they check (spec d25d923d R-13):
  // its task, else its mission's oldest line. With nothing to count under they
  // stay listed, so a running agent is never hidden.
  for (const h of helpers) {
    const host = (h.hostTaskId ? lines.find(l => l.taskId === h.hostTaskId) : undefined)
      ?? (h.missionId ? lines.filter(l => l.missionId === h.missionId).sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0))[0] : undefined);
    if (host) host.checks++;
    else lines.push(h.line);
  }
  // Slots the runners advertise beyond what the snapshot drew stay free.
  while (squares.length < fleet.capacity) squares.push('free');
  const total = Math.max(fleet.capacity, squares.length);
  lines.sort((a, b) => (b.elapsedMs ?? 0) - (a.elapsedMs ?? 0));
  return { busy: squares.filter(s => s !== 'free').length, total, squares, lines };
}

/** `2 checks running`: the helper runs under a line. */
export const checksRunningLabel = (n: number) => `${n} ${n === 1 ? 'check' : 'checks'} running`;

/** "3 of 4 busy". */
export const agentsSummary = (m: Pick<AgentsModel, 'busy' | 'total'>) => `${m.busy} of ${m.total} busy`;

/** `38m`, `1h 05m`, `2d`. */
export function elapsedLabel(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 ? `${h}h` : `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

/** The headline sentence: the count of what needs you, or a calm all-clear. */
export function homeHeadlineSentence(count: number): string {
  if (count <= 0) return 'All clear.';
  return count === 1 ? '1 decision for you.' : `${count} decisions for you.`;
}

/**
 * One plain sub-line: what is being repaired automatically, else that nothing
 * else is needed. Not narration of the fleet ("moving on its own").
 */
export function homeSubline(_count: number, repairs: number): string {
  if (repairs > 0) return repairs === 1 ? '1 automatic repair is running.' : `${repairs} automatic repairs are running.`;
  return 'No other action needed.';
}
