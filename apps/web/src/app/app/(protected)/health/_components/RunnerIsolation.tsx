import Disclosure from '@/components/ui/Disclosure';
import { observedAgo } from '@/lib/health-metric-grammar';
import { runnerIsolationDetail, type IsolationRunner } from '@/lib/runner-isolation-health';

/**
 * A runner's isolation in plain words (Living Spec "Runner isolation", R-10):
 * the platform, what confines each backend and mode, the cause when reduced,
 * the probe age, and the operator's steps. Read from the heartbeat, so it
 * needs no call to the runner. Opens by itself when something is reduced.
 */
export function RunnerIsolation({ runner, now }: { runner: IsolationRunner; now: number }) {
  const d = runnerIsolationDetail(runner);
  const reduced = d.cause !== null || d.steps.length > 0;
  const probed = d.probeAt ? `checked ${observedAgo(d.probeAt, now) ?? 'at an unknown time'}` : 'never checked';
  return (
    <div data-testid="runner-isolation" className="px-4 pb-3">
      <Disclosure summary={<span className="text-xs text-text-secondary">Sandbox · {probed}</span>} defaultOpen={reduced}>
        <div className="space-y-2 pt-1 text-xs">
          {d.platform && <p className="text-text-primary">Runs on {d.platform}.</p>}
          {d.backends.length > 0 && (
            <ul className="space-y-0.5">
              {d.backends.map(b => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span className="text-text-secondary">{b.label}</span>
                  <span className={b.confined ? 'text-status-success' : b.value === 'unknown' ? 'text-text-muted' : 'text-status-warning'}>
                    {b.value}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d.filesystem && <p className="text-text-secondary">{d.filesystem}</p>}
          {d.cause && <p className="text-text-primary">{d.cause}</p>}
          {d.allowed && <p className="text-text-muted">{d.allowed}</p>}
          {d.fixer && <p className="text-text-secondary">{d.fixer}</p>}
          {d.steps.length > 0 && (
            <ol className="list-decimal pl-4 space-y-0.5 text-text-secondary">
              {d.steps.map(step => <li key={step} className="break-words">{step}</li>)}
            </ol>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
