/**
 * What sits beside the chat when no object is docked (docs/design/agent-chat.md,
 * "Who sees what first"): a member gets what needs them and their missions; an
 * operator gets the fleet. The chat column is the same for both.
 */
import Link from 'next/link';

export interface ContextNeedsYou { id: string; title: string; href: string; meta?: string | null }
export interface ContextMission { id: string; title: string; state: string; meta?: string | null; tone?: 'live' | 'attention' | 'idle' }

export interface ChatContextPanelProps {
  audience: 'member' | 'operator';
  needsYou: readonly ContextNeedsYou[];
  missions: readonly ContextMission[];
  missionTotal?: number;
  /** Operators: agents live of capacity. */
  fleet?: { live: number; capacity: number } | null;
}

const EDGE = { live: 'border-l-accent', attention: 'border-l-status-warning', idle: 'border-l-border-strong' } as const;

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between font-mono text-[11px] font-semibold uppercase tracking-[2px] text-text-muted">
      <span>{children}</span>
      {right}
    </div>
  );
}

export default function ChatContextPanel({ audience, needsYou, missions, missionTotal, fleet }: ChatContextPanelProps) {
  const fleetBlock = fleet && (
    <Link
      href="/app/home"
      data-testid="chat-context-fleet"
      className={`flex items-center justify-between border-2 border-border-strong bg-card px-4 py-3 font-mono text-[13px] text-text-primary hover:bg-card-hover ${audience === 'member' ? '' : 'shadow-[var(--card-shadow)]'}`}
    >
      <span>{`${fleet.live} of ${fleet.capacity} agents busy`}</span>
      <span className="text-text-secondary">Fleet →</span>
    </Link>
  );
  return (
    <div data-testid="chat-context-panel" data-audience={audience} className="flex flex-col gap-7">
      <div className="flex items-center justify-between border-b-2 border-border-strong pb-2 font-mono text-[12px] font-bold uppercase tracking-[2px] text-text-primary">
        <span>{audience === 'member' ? 'Your work' : 'Fleet · live'}</span>
        <span className="font-normal normal-case tracking-normal text-text-muted">{audience === 'member' ? 'member view' : 'operator view'}</span>
      </div>
      {audience === 'operator' && fleetBlock}
      <section>
        <Label right={<span>{needsYou.length}</span>}>Needs you</Label>
        {needsYou.length === 0 ? (
          <p className="border-2 border-dashed border-border-default px-4 py-3 font-mono text-[12.5px] leading-relaxed text-text-muted">
            Nothing is waiting on you. Questions from agents show up here and in the chat.
          </p>
        ) : (
          <ul className="grid gap-2">
            {needsYou.map(n => (
              <li key={n.id}>
                <Link href={n.href} className="block border-2 border-status-warning bg-card px-4 py-2.5 hover:bg-card-hover">
                  <span className="block truncate font-mono text-[13px] font-semibold text-text-primary">{n.title}</span>
                  {n.meta && <span className="block truncate font-mono text-[11.5px] text-text-muted">{n.meta}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <Label right={<Link href="/app/missions" className="hover:text-text-primary">{`${missionTotal ?? missions.length} →`}</Link>}>
          {audience === 'member' ? 'Your missions' : 'Missions'}
        </Label>
        {missions.length === 0 ? (
          <p className="font-mono text-[12.5px] text-text-muted">No missions yet. Describe the work in the chat.</p>
        ) : (
          <ul className="grid gap-2">
            {missions.map(m => (
              <li key={m.id}>
                <Link href={`/app/missions/${m.id}`} className={`block border-2 border-l-[5px] border-border-strong bg-card px-4 py-2.5 hover:bg-card-hover ${EDGE[m.tone ?? 'live']}`}>
                  <span className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-[13px] font-semibold text-text-primary">{m.title}</span>
                    <span className="shrink-0 font-mono text-[11px] md:text-[10.5px] font-bold uppercase tracking-[1.2px] text-text-muted">{m.state}</span>
                  </span>
                  {m.meta && <span className="mt-0.5 block truncate font-mono text-[11.5px] text-text-muted">{m.meta}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      {audience === 'member' && fleetBlock}
    </div>
  );
}
