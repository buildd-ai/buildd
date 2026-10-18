'use client';

import { useCallback, useRef, useState } from 'react';

export const DEPLOY_STEPS = ['check', 'bucket', 'worker', 'containers', 'connect'] as const;
export type DeployStep = (typeof DEPLOY_STEPS)[number];

const LABELS: Record<DeployStep, string> = {
  check: 'Checking…',
  bucket: 'Creating snapshot bucket…',
  worker: 'Uploading Worker…',
  containers: 'Deploying containers…',
  connect: 'Connecting workspace…',
};

export interface DeployState {
  /** Idle until Deploy is pressed; running while steps are in flight; done/error at the end. */
  phase: 'idle' | 'running' | 'done' | 'error';
  /** The step currently in flight, or the last step that ran. */
  currentStep: DeployStep | null;
  /** Human-readable label for the current step. */
  label: string;
  /** Progress 0–1 (steps completed / total). */
  progress: number;
  /** The Worker URL on success. */
  workerUrl: string | null;
  /** Error message on failure. */
  error: string | null;
  /** Notes from the deploy (e.g. about the runner key). */
  notes: string[];
}

const INITIAL: DeployState = { phase: 'idle', currentStep: null, label: '', progress: 0, workerUrl: null, error: null, notes: [] };

export function useCloudRunnerDeploy() {
  const [state, setState] = useState<DeployState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  const deploy = useCallback(async (workspaceId: string) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...INITIAL, phase: 'running', currentStep: 'check', label: LABELS.check });
    const allNotes: string[] = [];

    for (let i = 0; i < DEPLOY_STEPS.length; i++) {
      if (ac.signal.aborted) return;
      const step = DEPLOY_STEPS[i];
      setState((s) => ({
        ...s,
        currentStep: step,
        label: LABELS[step],
        progress: i / DEPLOY_STEPS.length,
      }));
      try {
        const res = await fetch('/api/cloudflare/cloud-runner/deploy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ step, workspaceId }),
          signal: ac.signal,
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          setState((s) => ({
            ...s,
            phase: 'error',
            error: body.error ?? `Step "${step}" failed (HTTP ${res.status}).`,
            progress: i / DEPLOY_STEPS.length,
          }));
          return;
        }
        if (Array.isArray(body.detail?.notes)) allNotes.push(...body.detail.notes);
        // Last step done: extract the Worker URL.
        if (!body.next) {
          setState({
            phase: 'done',
            currentStep: step,
            label: 'Done',
            progress: 1,
            workerUrl: body.detail?.dispatchUrl ?? body.detail?.workerUrl ?? null,
            error: null,
            notes: allNotes,
          });
          return;
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        setState((s) => ({
          ...s,
          phase: 'error',
          error: err instanceof Error ? err.message : 'Deploy failed.',
          progress: i / DEPLOY_STEPS.length,
        }));
        return;
      }
    }
  }, []);

  return { state, deploy, reset };
}
