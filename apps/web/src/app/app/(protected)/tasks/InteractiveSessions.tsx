import Link from 'next/link';
import Chip from '@/components/ui/Chip';
import Section from '@/components/ui/Section';
import type { LocalSessionView, LocalSessionState } from '@/lib/local-session-view';

/**
 * Local interactive sessions (Claude Code, Codex, Cursor on someone's own
 * machine) reported by the buildd plugin's hooks. Separate from the task list
 * on purpose: a session is presence, not an agent, and holds no slot. Only a
 * session working on a task holds one, the one its own claim took.
 *
 * The client is a muted badge, never a task-state colour.
 */

export const SESSION_STATE_LABEL: Record<LocalSessionState, string> = {
  bound: 'Working',
  online: 'Online',
  offline: 'Offline',
  ended: 'Ended',
};

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

export default function InteractiveSessions({ sessions, now = Date.now() }: { sessions: LocalSessionView[]; now?: number }) {
  if (sessions.length === 0) return null;
  const online = sessions.filter(s => s.state === 'bound' || s.state === 'online').length;
  return (
    <div className="px-4" data-testid="interactive-sessions">
      <Section title={interactiveSessionsTitle()} count={online}>
        <ul className="flex flex-col divide-y divide-border-default border border-border-default bg-card">
          {sessions.map(s => (
            <li key={s.id} className="flex flex-col gap-1 px-3 py-2.5 min-h-11" data-testid="interactive-session" data-state={s.state}>
              <div className="flex items-center gap-2 min-w-0">
                <Chip tone="muted" dot={s.state === 'bound' || s.state === 'online'}>{s.clientLabel}</Chip>
                <span className={`text-[13px] ${s.state === 'ended' || s.state === 'offline' ? 'text-text-muted' : 'text-text-secondary'}`}>
                  {SESSION_STATE_LABEL[s.state]}
                </span>
                {s.repo && <span className="font-mono text-[11px] text-text-muted truncate">{s.repo}</span>}
                <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
                  {ago(s.endedAt ?? s.lastSeenAt, now)}
                </span>
              </div>
              {s.task && (
                <div className="flex flex-col gap-0.5 min-w-0">
                  <Link href={`/app/tasks/${s.task.id}`} className="text-[13px] text-text-primary truncate hover:underline">
                    {s.task.title}
                  </Link>
                  {s.workerLive && (
                    <span className="text-[12px] text-text-muted">
                      Runs on your machine. Buildd can release its slot, not close it.
                    </span>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}
