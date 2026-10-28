/**
 * Access on the task page: what this task's runs were given (repo access,
 * buildd tokens, model endpoints) and what they were refused, in order.
 * Read from agent_capability_decisions via lib/agent-capabilities/access-log.ts.
 *
 * The run's own credentials (buildd token, repo access, model endpoint) are
 * ordinary authentication, issued on start and renewed while it lives: shown as
 * one line each with renewals behind a toggle, and never as an approval. What
 * team policy or a person governs (capability requests and grants) is listed
 * apart; a request still waiting links to the one decision in Settings › Apps
 * (the same request as its Needs You card). A request whose run ended was
 * never decided and can no longer be: it reads as closed, with no link.
 *
 * A database query shows the SQL it ran, the row count and the time taken;
 * the rows themselves are never recorded.
 *
 * Collapsed by default; opens on its own when anything was refused or waits on
 * a person, since that is what someone opens it for. Renders nothing for a task with no
 * recorded decisions.
 */
import Chip from '@/components/ui/Chip';
import Disclosure from '@/components/ui/Disclosure';
import { ZonedTime } from '@/components/DisplayTimezone';
import type { AccessItem } from '@/lib/agent-capabilities/access-log';

const ROW = 'flex flex-wrap md:flex-nowrap items-baseline gap-x-3 gap-y-1 px-3 py-2 md:px-4 border-b border-border-default/40 last:border-b-0';

function RunCredential({ item }: { item: AccessItem }) {
  const renewals = item.count - 1;
  return (
    <li data-testid="task-access-item" data-source="run" data-decision={item.decision} className={ROW}>
      <span className="text-body text-text-primary flex-1 min-w-0">
        {item.label}
        {item.target && <span className="text-text-secondary"> · {item.target}</span>}
        {renewals > 0 && (
          <details className="inline-block align-baseline ml-2" data-testid="task-access-renewals">
            <summary className="inline cursor-pointer text-meta text-text-muted hover:text-text-primary min-h-11 md:min-h-0">
              renewed {renewals}×
            </summary>
            <span className="block text-meta text-text-muted">
              First issued <ZonedTime value={item.at} format="time" />, last renewed <ZonedTime value={item.lastAt} format="time" />. Issued by buildd when the run starts; nobody approved it.
            </span>
          </details>
        )}
      </span>
      <span className="text-meta basis-full md:basis-auto md:text-right text-text-muted">
        {item.decision === 'refused' ? (
          <span className="text-status-error">refused{item.reason ? ` · ${item.reason}` : ''}</span>
        ) : (
          <>
            active{item.reason ? ` · ${item.reason}` : ''}
            {item.expiresAt && <> · until <ZonedTime value={item.expiresAt} format="time" /></>}
          </>
        )}
      </span>
    </li>
  );
}

function Governed({ item }: { item: AccessItem }) {
  return (
    <li
      data-testid="task-access-item"
      data-source="grant"
      data-decision={item.pending ? 'pending' : item.closed ? 'closed' : item.decision}
      className={`${ROW} ${item.decision === 'refused' && !item.pending && !item.closed ? 'border-l-2 border-l-status-error' : ''}`}
    >
      <ZonedTime value={item.at} format="time" className="text-meta text-text-muted tabular-nums w-16 shrink-0" />
      <span className="text-body text-text-primary flex-1 min-w-0">
        {item.label}
        {item.target && <span className="text-text-secondary"> · {item.target}</span>}
        {item.query && (
          <span className="block mt-1" data-testid="task-access-query">
            <code className="block whitespace-pre-wrap break-words text-meta text-text-secondary">{item.query.sql}{item.query.sqlTruncated ? ' …' : ''}</code>
            {item.query.rowCount !== null && (
              <span className="text-meta text-text-muted">
                {item.query.rowCount} {item.query.rowCount === 1 ? 'row' : 'rows'}{item.query.truncated ? ' (capped)' : ''}
                {item.query.durationMs !== null && <> · {item.query.durationMs} ms</>}
              </span>
            )}
          </span>
        )}
      </span>
      <span className="text-meta basis-full md:basis-auto md:text-right">
        {item.pending ? (
          item.grantId ? (
            <a data-testid="task-access-review" href={`/app/settings/apps?request=${encodeURIComponent(item.grantId)}#agent-access`} className="text-text-primary underline underline-offset-2 inline-flex items-center min-h-11 md:min-h-0">
              waiting on a person · Review
            </a>
          ) : <span className="text-text-muted">waiting on a person</span>
        ) : item.closed ? (
          <span data-testid="task-access-closed" className="text-text-muted">closed · {item.closed}</span>
        ) : item.decision === 'refused' ? (
          <span className="text-status-error">refused{item.reason ? ` · ${item.reason}` : ''}</span>
        ) : (
          <span className="text-text-muted">
            allowed{item.reason ? ` · ${item.reason}` : ''}
            {item.expiresAt && <> · until <ZonedTime value={item.expiresAt} format="time" /></>}
          </span>
        )}
      </span>
    </li>
  );
}

export default function TaskAccessSection({ items }: { items: AccessItem[] }) {
  if (items.length === 0) return null;
  const refused = items.filter(i => i.decision === 'refused' && !i.pending && !i.closed).length;
  const waiting = items.filter(i => i.pending).length;
  const run = items.filter(i => i.source === 'run');
  const governed = items.filter(i => i.source !== 'run');
  return (
    <div data-testid="task-access" className="mb-8">
      <Disclosure
        defaultOpen={refused > 0 || waiting > 0}
        count={items.length}
        summary={
          <span className="flex items-center gap-3">
            <span className="text-eyebrow font-bold text-text-muted">Access</span>
            {waiting > 0 && <Chip tone="warning" data-testid="task-access-waiting">{waiting} waiting on a person</Chip>}
            {refused > 0 && <Chip tone="error" data-testid="task-access-refused">{refused} refused</Chip>}
          </span>
        }
      >
        <div className="space-y-4">
          {run.length > 0 && (
            <div data-testid="task-access-run">
              <p className="text-meta text-text-muted mb-1">Run credentials</p>
              <ul className="border border-border-default">{run.map((item, i) => <RunCredential key={`${item.at}-${i}`} item={item} />)}</ul>
            </div>
          )}
          {governed.length > 0 && (
            <div data-testid="task-access-governed">
              <p className="text-meta text-text-muted mb-1">Requests and actions</p>
              <ul className="border border-border-default">{governed.map((item, i) => <Governed key={`${item.at}-${i}`} item={item} />)}</ul>
            </div>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
