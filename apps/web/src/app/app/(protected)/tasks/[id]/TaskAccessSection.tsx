/**
 * Access on the task page: what this task's runs were given (repo access,
 * buildd tokens, model endpoints) and what they were refused, in order.
 * Read from agent_capability_decisions via lib/agent-capabilities/access-log.ts.
 *
 * Collapsed by default; opens on its own when anything was refused, since
 * that is what someone opens it for. Renders nothing for a task with no
 * recorded decisions.
 */
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import { ZonedTime } from '@/components/DisplayTimezone';
import type { AccessItem } from '@/lib/agent-capabilities/access-log';

export default function TaskAccessSection({ items }: { items: AccessItem[] }) {
  if (items.length === 0) return null;
  const refused = items.filter(i => i.decision === 'refused').length;
  return (
    <div data-testid="task-access" className="mb-8">
      <Disclosure
        defaultOpen={refused > 0}
        count={items.length}
        summary={
          <span className="flex items-center gap-3">
            <span className="text-eyebrow font-bold text-text-muted">Access</span>
            {refused > 0 && (
              <Chip tone="error" data-testid="task-access-refused">{refused} refused</Chip>
            )}
          </span>
        }
      >
        <ul className="border border-border-default">
          {items.map((item, i) => (
            <li
              key={`${item.at}-${i}`}
              data-testid="task-access-item"
              data-decision={item.decision}
              className={`flex flex-wrap md:flex-nowrap items-baseline gap-x-3 gap-y-1 px-3 py-2 md:px-4 border-b border-border-default/40 last:border-b-0 ${item.decision === 'refused' ? 'border-l-2 border-l-status-error' : ''}`}
            >
              <ZonedTime value={item.at} format="time" className="text-meta text-text-muted tabular-nums w-16 shrink-0" />
              <span className="text-body text-text-primary flex-1 min-w-0">
                {item.label}
                {item.target && <span className="text-text-secondary"> · {item.target}</span>}
                {item.count > 1 && <span className="text-text-muted"> · renewed {item.count - 1}×</span>}
              </span>
              <span className="text-meta basis-full md:basis-auto md:text-right">
                {item.decision === 'refused' ? (
                  <span className="text-status-error">refused{item.reason ? ` · ${item.reason}` : ''}</span>
                ) : (
                  <span className="text-text-muted">
                    allowed{item.reason ? ` · ${item.reason}` : ''}
                    {item.expiresAt && (
                      <> · until <ZonedTime value={item.expiresAt} format="time" /></>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}
