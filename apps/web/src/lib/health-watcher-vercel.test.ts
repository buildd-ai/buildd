import { describe, it, expect } from 'bun:test';
import { evaluateDeploymentHealth, type VercelDeployment } from './health-watcher-vercel';

const T = (ms: number) => new Date(ms).toISOString();
const NOW = 1_700_000_000_000;
const MIN = 60_000;

function deploy(over: Partial<VercelDeployment>): VercelDeployment {
  return {
    uid: 'dpl-test',
    state: 'READY',
    created: NOW,
    target: 'production',
    url: 'app.vercel.app',
    inspectorUrl: 'https://vercel.com/x/y/z',
    ...over,
  };
}

describe('evaluateDeploymentHealth', () => {
  it('returns unknown when there are no deployments', () => {
    const r = evaluateDeploymentHealth([], { graceMin: 60, now: NOW });
    expect(r.status).toBe('unknown');
    expect(r.dedupeKey).toBeNull();
  });

  it('healthy when latest is READY within grace window', () => {
    const r = evaluateDeploymentHealth(
      [deploy({ uid: 'dpl-1', created: NOW - 5 * MIN })],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('healthy');
  });

  it('unhealthy when latest is ERROR', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-bad', state: 'ERROR', created: NOW - 2 * MIN }),
        deploy({ uid: 'dpl-ok', state: 'READY', created: NOW - 20 * MIN }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('unhealthy');
    expect(r.reason).toContain('ERROR');
    expect(r.dedupeKey).toBe('deploy-dpl-bad');
    expect(r.deployment?.uid).toBe('dpl-bad');
  });

  it('unhealthy when latest is CANCELED', () => {
    const r = evaluateDeploymentHealth(
      [deploy({ uid: 'dpl-cx', state: 'CANCELED', created: NOW - 2 * MIN })],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('unhealthy');
    expect(r.dedupeKey).toBe('deploy-dpl-cx');
  });

  it('stale when no READY deploy exists within grace window', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-build', state: 'BUILDING', created: NOW - 5 * MIN }),
        deploy({ uid: 'dpl-old', state: 'READY', created: NOW - 90 * MIN }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('stale');
    // dedupe should be stable per-stale-window so we don't refire every hour
    expect(r.dedupeKey).toBe('stale-dpl-old');
    expect(r.deployment?.uid).toBe('dpl-old');
  });

  it('healthy when latest is BUILDING but a recent READY backs it up', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-build', state: 'BUILDING', created: NOW - 2 * MIN }),
        deploy({ uid: 'dpl-ok', state: 'READY', created: NOW - 10 * MIN }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('healthy');
  });

  it('unknown when there are only QUEUED/BUILDING deploys and no prior READY', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-q', state: 'QUEUED', created: NOW - MIN }),
        deploy({ uid: 'dpl-b', state: 'BUILDING', created: NOW - 5 * MIN }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('unknown');
    expect(r.dedupeKey).toBeNull();
  });

  it('orders deployments by created-desc even if input is unsorted', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-mid', state: 'READY', created: NOW - 30 * MIN }),
        deploy({ uid: 'dpl-new', state: 'ERROR', created: NOW - 5 * MIN }),
        deploy({ uid: 'dpl-old', state: 'READY', created: NOW - 90 * MIN }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('unhealthy');
    expect(r.deployment?.uid).toBe('dpl-new');
  });

  it('only considers production-target deploys', () => {
    const r = evaluateDeploymentHealth(
      [
        deploy({ uid: 'dpl-preview', state: 'ERROR', created: NOW - MIN, target: null }),
        deploy({ uid: 'dpl-prod', state: 'READY', created: NOW - 10 * MIN, target: 'production' }),
      ],
      { graceMin: 60, now: NOW },
    );
    expect(r.status).toBe('healthy');
  });
});
