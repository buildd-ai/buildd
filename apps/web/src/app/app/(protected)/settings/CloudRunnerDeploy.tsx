'use client';

import { useCallback, useEffect, useState } from 'react';
import { Select } from '@/components/ui/Select';
import { useCloudRunnerDeploy, DEPLOY_STEPS, type DeployStep } from './_lib/use-cloud-runner-deploy';
import { missingDeployPermissions, type CloudflareCapabilities } from '@/lib/cloudflare-credential-shared';

interface Props {
  teamId: string;
  capabilities: CloudflareCapabilities | null;
}

/**
 * Deploy button inside the verified-Cloudflare section: workspace picker →
 * step-by-step deploy → Worker URL on success. Only shown to a team
 * owner/admin whose Cloudflare token is verified.
 *
 * The route (`/api/cloudflare/cloud-runner/deploy`) does the team scoping,
 * mints the runner key and runs every Cloudflare call through the audited
 * deployment action path. This component drives the UI.
 */
export default function CloudRunnerDeploy({ teamId, capabilities }: Props) {
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedWs, setSelectedWs] = useState('');
  const [loadingWs, setLoadingWs] = useState(true);
  const { state, deploy, reset } = useCloudRunnerDeploy();

  useEffect(() => {
    let cancelled = false;
    setLoadingWs(true);
    fetch(`/api/cloudflare/cloud-runner/deploy?teamId=${teamId}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        const ws = Array.isArray(d.workspaces) ? d.workspaces : [];
        setWorkspaces(ws);
        if (ws.length > 0 && !ws.find((w: { id: string }) => w.id === selectedWs)) setSelectedWs(ws[0].id);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingWs(false); });
    return () => { cancelled = true; };
  }, [teamId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startDeploy = useCallback(() => {
    if (!selectedWs) return;
    deploy(selectedWs);
  }, [selectedWs, deploy]);

  const missingPerms = missingDeployPermissions(capabilities);
  const running = state.phase === 'running';
  const done = state.phase === 'done';
  const failed = state.phase === 'error';
  const stepIdx = state.currentStep ? DEPLOY_STEPS.indexOf(state.currentStep) : -1;

  if (loadingWs) {
    return <div data-testid="cloud-deploy-loading" className="text-xs text-text-tertiary py-1">Loading workspaces…</div>;
  }

  if (workspaces.length === 0) return null;

  return (
    <div data-testid="cloud-deploy" className="space-y-3 py-1">
      {missingPerms.length > 0 && (
        <p data-testid="cloud-deploy-perms" className="text-xs text-status-error">
          This token is missing permissions the deploy needs: {missingPerms.join(', ')}.
          Add them in Cloudflare, then Verify again.
        </p>
      )}

      {!running && !done && (
        <div className="flex items-end gap-3">
          <label className="flex-1 min-w-0">
            <span className="field-label">Workspace</span>
            <Select
              aria-label="Deploy workspace"
              value={selectedWs}
              onChange={setSelectedWs}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </label>
          <button
            onClick={startDeploy}
            disabled={!selectedWs || missingPerms.length > 0}
            data-testid="cloud-deploy-btn"
            className="btn btn-primary h-10 whitespace-nowrap"
          >
            Deploy
          </button>
        </div>
      )}

      {(running || done || failed) && (
        <div className="space-y-2">
          <div className="text-sm font-medium text-text-primary">
            {running ? 'Deploying…' : done ? 'Deployed' : 'Deploy failed'}
          </div>

          {/* Step progress list */}
          <ol data-testid="cloud-deploy-steps" className="text-xs space-y-1">
            {DEPLOY_STEPS.map((s, i) => {
              const isDone = i < stepIdx || (i === stepIdx && done);
              const isCurrent = i === stepIdx && running;
              const isFailed = i === stepIdx && failed;
              const isPending = i > stepIdx || (i === stepIdx && !running && !done && !failed);
              return (
                <li key={s} className={
                  isDone ? 'text-status-success' :
                  isCurrent ? 'text-text-primary font-medium' :
                  isFailed ? 'text-status-error' :
                  'text-text-muted'
                }>
                  {isDone ? '✓' : isCurrent ? '›' : isFailed ? '✗' : '·'}{' '}
                  {stepLabel(s)}
                </li>
              );
            })}
          </ol>

          {/* Progress bar */}
          {running && (
            <div className="h-1.5 rounded-full bg-surface overflow-hidden">
              <div
                className="h-full bg-accent-primary rounded-full transition-all duration-500"
                style={{ width: `${Math.round(state.progress * 100)}%` }}
              />
            </div>
          )}

          {failed && state.error && (
            <p data-testid="cloud-deploy-error" className="text-xs text-status-error break-words">
              {state.error}
            </p>
          )}

          {done && state.workerUrl && (
            <p data-testid="cloud-deploy-url" className="text-xs text-text-secondary">
              Worker URL: <span className="font-mono select-all">{state.workerUrl}</span>
            </p>
          )}

          {state.notes.length > 0 && (
            <ul className="text-xs text-text-muted space-y-0.5">
              {state.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          )}

          <div className="flex gap-2">
            {failed && (
              <button onClick={startDeploy} data-testid="cloud-deploy-retry" className="btn btn-primary">
                Retry
              </button>
            )}
            {(done || failed) && (
              <button onClick={reset} className="btn btn-quiet">
                {done ? 'Deploy another' : 'Cancel'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function stepLabel(s: DeployStep): string {
  switch (s) {
    case 'check': return 'Pre-flight check';
    case 'bucket': return 'Snapshot bucket';
    case 'worker': return 'Worker upload';
    case 'containers': return 'Container applications';
    case 'connect': return 'Connect workspace';
  }
}
