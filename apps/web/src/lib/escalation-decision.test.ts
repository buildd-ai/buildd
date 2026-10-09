/**
 * Where Jev runs for an escalation: in the background when a PR's state
 * changes, never while a page or list_prs loads.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEscalationDecisionScheduler, escalationGateReadDeps } from './escalation-decision';
import type { GatedSubject } from './escalation-gate-check';

const subject = (key: string): GatedSubject => ({
  key, workspaceId: 'ws', prNumber: 7, taskId: 't', missionId: null, title: 'x',
  why: 'reviewer_escalated', ci: 'green', conflict: false, machineActing: false, missionPrRole: null, teamId: 'team',
});

describe('escalationGateReadDeps', () => {
  it('never decides', () => {
    expect(escalationGateReadDeps().decide).toBe(false);
    expect(typeof escalationGateReadDeps().enqueue).toBe('function');
  });
});

describe('createEscalationDecisionScheduler', () => {
  it('runs the look after the response, in decide mode', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const seen: Array<{ keys: string[]; decide: boolean | undefined }> = [];
    const enqueue = createEscalationDecisionScheduler(
      task => { scheduled.push(task); },
      async (subjects, deps) => { seen.push({ keys: subjects.map(s => s.key), decide: deps.decide }); return new Map(); },
    );
    enqueue([subject('a')]);
    expect(seen).toHaveLength(0);
    await scheduled[0]();
    expect(seen).toEqual([{ keys: ['a'], decide: true }]);
  });

  it('outside a request scope it still runs, fire-and-forget', async () => {
    const seen: string[] = [];
    const enqueue = createEscalationDecisionScheduler(
      () => { throw new Error('after() outside a request'); },
      async subjects => { seen.push(...subjects.map(s => s.key)); return new Map(); },
    );
    enqueue([subject('a')]);
    await new Promise(r => setTimeout(r, 0));
    expect(seen).toEqual(['a']);
  });

  it('two loads of the same state at once make one look', async () => {
    const scheduled: Array<() => Promise<void>> = [];
    const seen: string[] = [];
    const enqueue = createEscalationDecisionScheduler(
      task => { scheduled.push(task); },
      async subjects => { seen.push(...subjects.map(s => s.key)); return new Map(); },
    );
    enqueue([subject('a')]);
    enqueue([subject('a'), subject('b')]);
    await Promise.all(scheduled.map(t => t()));
    expect(seen.sort()).toEqual(['a', 'b']);
  });
});

describe('surfaces read, never decide', () => {
  const src = (p: string) => readFileSync(join(import.meta.dir, p), 'utf8');

  it('Home reads stored verdicts with the read deps', () => {
    const home = src('../app/app/(protected)/home/page.tsx');
    expect(home).toContain('ESCALATION_GATE_READ_DEPS');
    expect(home).not.toMatch(/gateEscalations\([^)]*ESCALATION_GATE_DEPS\(\)/);
  });

  it('the PR inbox, badge and list_prs read with the read deps', () => {
    const attention = src('./pr-attention.ts');
    expect(attention).toContain('escalationGateReadDeps()');
    expect(attention).not.toMatch(/gateEscalations\([^)]*\.\.\.escalationGateDeps\(\)/);
  });
});
