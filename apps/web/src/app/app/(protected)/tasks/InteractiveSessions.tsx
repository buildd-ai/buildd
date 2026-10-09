import Link from 'next/link';
import { displayTaskTitle } from '@/lib/task-title';
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import Section from '@/components/ui/Section';
// Client-safe: the collapse rules, and types only from the db-backed view module.
import { groupSessionsForDisplay, sessionTaskPreview } from '@/lib/local-session-display';
import type { LocalSessionView, LocalSessionState, LocalSessionTaskView } from '@/lib/local-session-view';

/**
 * Local interactive sessions (Claude Code, Codex, Cursor on someone's own
 * machine) reported by the buildd plugin's hooks. Separate from the task list
 * on purpose: a session is presence, not an agent, and holds no slot. Only a
 * session working on a task holds one, the one its own claim took.
 *
 * Collapsed so it never buries the task list: sessions working on a task are
 * shown; online sessions with no task fold into one line once there are more
 * than two; offline and ended sessions fold under "N earlier sessions"; a
 * session lists at most three tasks, then "+N more". Live work is also on
 * Home's runner board (the "Your sessions" lane); this is the history.
 *
 * The client is a muted badge, never a task-state colour.
 */

export const SESSION_STATE_LABEL: Record<LocalSessionState, string> = {
  bound: 'Working',
  online: 'Online',
  offline: 'Offline',
  ended: 'Ended',
};

/** Up to this many idle online sessions are rows; more fold into one line. */
const IDLE_ONLINE_ROWS = 2;

function ago(iso: string, now: number): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function interactiveSessionsTitle(): string {
  return 'Interactive sessions';
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function TaskLink({ t }: { t: LocalSessionTaskView }) {
  return (
    <Link href={`/app/tasks/${t.id}`} className="block min-h-6 truncate text-body text-text-primary hover:underline" title={t.title}>
      {displayTaskTitle(t.title)}
    </Link>
  );
}

function SessionRow({ s, now }: { s: LocalSessionView; now: number }) {
  const { shown, hidden } = sessionTaskPreview(s);
  const quiet = s.state === 'ended' || s.state === 'offline';
  return (
    <li className="flex flex-col gap-1 px-3 py-2.5 min-h-11" data-testid="interactive-session" data-state={s.state}>
      <div className="flex items-center gap-2 min-w-0">
        <Chip tone="muted" dot={s.state === 'bound' || s.state === 'online'}>{s.clientLabel}</Chip>
        <span className={`text-body ${quiet ? 'text-text-muted' : 'text-text-secondary'}`}>{SESSION_STATE_LABEL[s.state]}</span>
        {s.repo && <span className="font-mono text-meta text-text-muted truncate">{s.repo}</span>}
        <span className="ml-auto shrink-0 font-mono text-meta text-text-muted">{ago(s.endedAt ?? s.lastSeenAt, now)}</span>
      </div>
      {shown.length > 0 && (
        <div className="flex flex-col min-w-0">
          {shown.map(t => <TaskLink key={t.id} t={t} />)}
          {hidden.length > 0 && (
            <Disclosure summary={<span className="text-meta text-text-muted">+{hidden.length} more</span>}>
              <div className="flex flex-col">{hidden.map(t => <TaskLink key={t.id} t={t} />)}</div>
            </Disclosure>
          )}
          {s.workerLive && (
            <span className="text-meta text-text-muted">Runs on your machine. Buildd can release its slot, not close it.</span>
          )}
        </div>
      )}
    </li>
  );
}

function Rows({ sessions, now }: { sessions: LocalSessionView[]; now: number }) {
  return (
    <ul className="flex flex-col divide-y divide-border-default">
      {sessions.map(s => <SessionRow key={s.id} s={s} now={now} />)}
    </ul>
  );
}

export default function InteractiveSessions({ sessions, now = Date.now() }: { sessions: LocalSessionView[]; now?: number }) {
  if (sessions.length === 0) return null;
  const { working, idleOnline, earlier } = groupSessionsForDisplay(sessions);
  const foldIdle = idleOnline.length > IDLE_ONLINE_ROWS;
  const shownRows = foldIdle ? working : [...working, ...idleOnline];
  return (
    <div className="px-4" data-testid="interactive-sessions">
      <Section title={interactiveSessionsTitle()} count={working.length + idleOnline.length}>
        <div className="flex flex-col divide-y divide-border-default border border-border-default bg-card">
          {shownRows.length > 0 && <Rows sessions={shownRows} now={now} />}
          {foldIdle && (
            <div className="px-3">
              <Disclosure summary={`${idleOnline.length} online with no task`}>
                <Rows sessions={idleOnline} now={now} />
              </Disclosure>
            </div>
          )}
          {earlier.length > 0 && (
            <div className="px-3" data-testid="interactive-sessions-earlier">
              <Disclosure summary={plural(earlier.length, 'earlier session', 'earlier sessions')}>
                <Rows sessions={earlier} now={now} />
              </Disclosure>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}
