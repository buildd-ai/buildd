import Link from 'next/link';
import type { ReactElement } from 'react';
import type { TimelineEvent, TimelineGroup } from '@/lib/task-timeline';
import { formatElapsed } from './format-elapsed';

const marks = { passed: '✓', failed: '×', running: '◐', pending: '○', muted: '·' };
const tones = { passed: 'text-status-success', failed: 'text-status-error', running: 'text-accent-text', pending: 'text-text-muted', muted: 'text-text-muted' };
/** Times are ages; a duration stays in the event's subline (R-8). */
const ago = (at: string | null, nowMs: number) => at ? `${formatElapsed(nowMs - Date.parse(at))} ago` : null;
function Event({ item, nowMs }: { item: TimelineEvent; nowMs: number }): ReactElement {
  const age = ago(item.at, nowMs);
  return <li className="border-t border-border-default/50 first:border-0">
    <div className="flex items-start gap-3 py-2 text-body">
      <span className={`shrink-0 ${tones[item.state]}`} aria-label={item.state}>{marks[item.state]}</span>
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        {item.taskId ? <Link className="inline-flex min-h-11 items-center hover:underline" href={`/app/tasks/${item.taskId}`}>{item.label}</Link> : <p>{item.label}</p>}
        {item.detail && <p className="text-meta text-text-muted">{item.detail}</p>}
      </div>
      {age && <time dateTime={item.at!} data-testid="task-timeline-age" className="shrink-0 font-mono text-meta text-text-muted tabular-nums">{age}</time>}
    </div>
    {item.children.length > 0 && <ol className="ml-7 border-l border-border-default pl-3">{item.children.map(child => <Event key={child.id} item={child} nowMs={nowMs} />)}</ol>}
  </li>;
}
export default function TaskTimeline({ groups, nowMs = Date.now() }: { groups: TimelineGroup[]; nowMs?: number }): ReactElement | null {
  if (!groups.length) return null;
  return <section data-testid="task-timeline" aria-label="Task timeline" className="card mb-5 px-4 py-2">
    {groups.map(group => <section key={group.label} className="border-t border-border-default py-2 first:border-0">
      <h2 className="font-mono text-meta text-text-muted mb-1">{group.label}</h2>
      <ol>{group.events.map(item => <Event key={item.id} item={item} nowMs={nowMs} />)}</ol>
    </section>)}
  </section>;
}
