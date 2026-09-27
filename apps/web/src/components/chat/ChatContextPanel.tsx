/**
 * What sits beside the chat when no object is docked (docs/design/agent-chat.md,
 * "Who sees what first"): a member gets what needs them and their missions; an
 * operator gets the fleet. The chat column is the same for both.
 *
 * A section shows only when it has something in it. An idle fleet is one quiet
 * line, and a panel with nothing in it renders nothing (the chat takes the width).
 */
import Link from 'next/link';

export interface ContextNeedsYou {
  id: string;
  title: string;
  href: string;
  meta?: string | null;
  /** The task's short label (tasks.label), for the canvas's row 1 action. */
  label?: string | null;
  /** What the worker is waiting for (workers.waitingFor.type). */
  waitingType?: string | null;
  /** The waiting task and its workspace (the desktop dock loads it). */
  taskId?: string | null;
  workspaceId?: string | null;
}
export interface ContextMission { id: string; title: string; state: string; meta?: string | null; tone?: 'live' | 'attention' | 'idle' }

export interface ChatContextPanelProps {
  audience: 'member' | 'operator';
  needsYou: readonly ContextNeedsYou[];
  missions: readonly ContextMission[];
  missionTotal?: number;
  /** Agents live of capacity. */
  fleet?: { live: number; capacity: number } | null;
}

export interface ContextPanelModel {
  needsYou: boolean;
  missions: boolean;
  fleet: 'busy' | 'idle' | 'none';
  /** Nothing worth a column: the caller drops the aside. */
  empty: boolean;
}

/** Which sections render. Pure. */
export function contextPanelModel(p: Pick<ChatContextPanelProps, 'needsYou' | 'missions' | 'fleet'>): ContextPanelModel {
  const fleet = !p.fleet ? 'none' : p.fleet.live > 0 ? 'busy' : 'idle';
  const needsYou = p.needsYou.length > 0;
  const missions = p.missions.length > 0;
  // An idle fleet alone isn't worth a 400px column.
  return { needsYou, missions, fleet, empty: !needsYou && !missions && fleet !== 'busy' };
}

const EDGE = { live: 'border-l-accent', attention: 'border-l-status-warning', idle: 'border-l-border-strong' } as const;
const LIST = 'grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2';

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3 font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
      <span className="min-w-0 truncate">{children}</span>
      {right}
    </div>
  );
}

export default function ChatContextPanel({ audience, needsYou, missions, missionTotal, fleet }: ChatContextPanelProps) {
  const model = contextPanelModel({ needsYou, missions, fleet });
  if (model.empty) return null;

  const fleetBlock = model.fleet === 'busy' && fleet ? (
    <Link
      href="/app/home"
      data-testid="chat-context-fleet"
      className={`flex min-w-0 items-center justify-between gap-3 border-2 border-border-strong bg-card px-4 py-3 font-mono text-[13px] text-text-primary hover:bg-card-hover ${audience === 'member' ? '' : 'shadow-[var(--card-shadow)]'}`}
    >
      <span className="min-w-0 truncate">{`${fleet.live} of ${fleet.capacity} agents busy`}</span>
      <span className="shrink-0 text-text-secondary">Fleet →</span>
    </Link>
  ) : model.fleet === 'idle' ? (
    <Link
      href="/app/home"
      data-testid="chat-context-fleet-idle"
      className="inline-flex min-h-9 items-center font-mono text-[12px] text-text-muted hover:text-text-primary"
    >
      Fleet idle →
    </Link>
  ) : null;

  return (
    <div data-testid="chat-context-panel" data-audience={audience} className="flex min-w-0 flex-col gap-7">
      {audience === 'operator' && fleetBlock}
      {model.needsYou && (
        <section className="min-w-0">
          <Label right={<span className="shrink-0">{needsYou.length}</span>}>Needs you</Label>
          <ul className={LIST}>
            {needsYou.map(n => (
              <li key={n.id} className="min-w-0">
                <Link href={n.href} className="block min-w-0 border-2 border-status-warning bg-card px-4 py-2.5 hover:bg-card-hover">
                  <span className="block truncate font-mono text-[13px] font-semibold text-text-primary">{n.title}</span>
                  {n.meta && <span className="block truncate font-mono text-[11.5px] text-text-muted">{n.meta}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {model.missions && (
        <section className="min-w-0">
          <Label right={<Link href="/app/missions" className="shrink-0 hover:text-text-primary">{`${missionTotal ?? missions.length} →`}</Link>}>
            {audience === 'member' ? 'Your missions' : 'Missions'}
          </Label>
          <ul className={LIST}>
            {missions.map(m => (
              <li key={m.id} className="min-w-0">
                <Link href={`/app/missions/${m.id}`} className={`block min-w-0 border-2 border-l-[5px] border-border-strong bg-card px-4 py-2.5 hover:bg-card-hover ${EDGE[m.tone ?? 'live']}`}>
                  <span className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-text-primary">{m.title}</span>
                    <span className="shrink-0 font-mono text-[11px] md:text-[10.5px] font-bold uppercase tracking-[1.2px] text-text-muted">{m.state}</span>
                  </span>
                  {m.meta && <span className="mt-0.5 block truncate font-mono text-[11.5px] text-text-muted">{m.meta}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {audience === 'member' && fleetBlock}
    </div>
  );
}
