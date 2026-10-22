import Disclosure from '@/components/ui/Disclosure';
import { observedAgo } from '@/lib/health-metric-grammar';
import { runnerIsolationDetail, type IsolationRunner } from '@/lib/runner-isolation-health';

/**
 * A runner's isolation in plain words (Living Spec "Runner isolation", R-10):
 * one line naming its state (sandbox on, disabled by you, not confirmed, out of
 * date, none), then which tasks it takes, the waiting tasks it refuses, what
 * confines each backend, the cause, who fixes it and the steps. Read from the
 * heartbeat, so it needs no call to the runner. Opens by itself only when
 * someone needs to act; an opt-out its operator chose stays closed.
 */
export function RunnerIsolation({ runner, now, expanded = false }: { runner: IsolationRunner; now: number; expanded?: boolean }) {
  const d = runnerIsolationDetail(runner);
  // A checked sandbox says "sandboxed" in the row; its mechanisms and probe
  // time are diagnostics, shown once the row is opened.
  if (d.state === 'verified' && !expanded) return null;
  // The probe is the sandbox check, not the heartbeat; a stale one says so.
  const probed = !d.probeAt
    ? 'never checked'
    : d.probeCurrent
      ? `checked ${observedAgo(d.probeAt, now) ?? 'at an unknown time'}`
      : `last checked ${observedAgo(d.probeAt, now) ?? 'at an unknown time'}, before the runner restarted`;
  const tone = d.attention ? 'text-status-warning' : d.state === 'verified' ? 'text-status-success' : 'text-text-secondary';
  const blockedTotal = (runner.isolationBlocked?.protected ?? 0) + (runner.isolationBlocked?.trustedLocal ?? 0);
  const setup = runner.mine && !runner.shared && d.probeCurrent && runner.isolation
    && !runner.isolation.reducedOptIn && runner.isolation.claude.mechanism === 'none';
  const partial = runner.isolation && [runner.isolation.claude, ...Object.values(runner.isolation.codex)].some(c => c && c.mechanism !== 'none');
  const message = d.blocked ?? (d.state === 'verified' ? 'Sandbox enabled.'
    : d.state === 'opted_out' ? 'Trusted tasks can run here.'
      : d.state === 'unknown' || d.state === 'stale' ? 'Restart or update this runner to check its sandbox.'
        : partial ? 'Some backends can run trusted tasks. See sandbox details.' : 'Takes no tasks until setup is complete.');
  return (
    <div data-testid="runner-isolation" data-state={d.state} className="px-4 pb-3">
      <Disclosure
        summary={
          <span className="text-xs">
            <span data-testid="runner-isolation-headline" className={tone}>{d.headline}</span>
            {!d.attention && blockedTotal > 0 && <span className="text-text-muted"> · {blockedTotal} waiting can&apos;t run here</span>}
          </span>
        }
        defaultOpen={d.attention}
      >
        <div className="space-y-2 pt-1 text-xs">
          <p data-testid="runner-isolation-blocked" className="text-text-primary">{message}</p>
          {setup && (
            <Disclosure summary="Set up Claude">
              <p className="text-text-secondary">Allow Claude to run trusted tasks without a sandbox. Stop the runner, then start it {runner.isolation?.platform === 'windows' ? 'in PowerShell' : 'in a terminal'}:</p>
              <pre className="my-2 whitespace-pre-wrap break-all font-mono text-xs">{runner.isolation?.platform === 'windows'
                ? "$env:BUILDD_ALLOW_REDUCED_ISOLATION='1'\nbuildd"
                : 'BUILDD_ALLOW_REDUCED_ISOLATION=1 buildd'}</pre>
            </Disclosure>
          )}
          <Disclosure summary="Sandbox details">
          <div className="space-y-2">
          {d.backends.length > 0 && (
            <ul className="space-y-0.5">
              {d.backends.map(b => (
                <li key={b.label} className="flex justify-between gap-3">
                  <span className="text-text-secondary">{b.label}</span>
                  <span className={b.confined ? 'text-status-success' : b.value === 'unknown' || b.value === 'off' ? 'text-text-muted' : 'text-status-warning'}>
                    {b.value}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {d.cause && d.state !== 'opted_out' && <p className="text-text-secondary">{d.cause}</p>}
          {d.filesystem && <p className="text-text-secondary">{d.filesystem}</p>}
          {d.steps.length > 0 && (
            <div>
              {d.state === 'opted_out' && <p className="text-text-muted">To turn it back on:</p>}
              <ol className="list-decimal pl-4 space-y-0.5 text-text-secondary">
                {d.steps.map(step => <li key={step} className="break-words">{step}</li>)}
              </ol>
            </div>
          )}
          <p className="text-text-muted">{d.platform ? `${d.platform} · ` : ''}Sandbox {probed}. {d.fixer ? runner.mine ? 'Managed on this computer.' : 'Managed by the runner operator.' : ''}</p>
          </div>
          </Disclosure>
        </div>
      </Disclosure>
    </div>
  );
}
