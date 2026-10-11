import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveRunEvidence } from '@buildd/core/run-evidence';
import NowStrip, { PausedBar, runLifecycleState } from './NowStrip';
import { deriveNow } from './task-activity';

const live = () => deriveNow(
  [{ type: 'checkpoint', event: 'first_edit', ts: 5 } as never],
  { status: 'running', currentAction: null, startMs: 0, nowMs: 20, prUrl: null, filesChanged: 0, commitCount: 0 } as never,
);

describe('evidence rail', () => {
  it('leads with the one Lifecycle track; no percent displays', () => {
    const now = deriveNow([{ type:'status', progress:70, label:'Checking changes', ts:10 }], { status:'running', currentAction:null, startMs:0, nowMs:20, prUrl:null, filesChanged:2 });
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    expect(html).toContain('run-evidence-rail');
    expect(html).toMatch(/data-testid="lifecycle" data-state="running"/);
    expect(html).not.toContain('worker-now-pct');
    expect(html).not.toContain('worker-progress-bar');
    expect(html).not.toContain('70%');
  });

  it('the phase evidence sits behind a 44px disclosure, closed by default, naming the head phase as n of m', () => {
    const now = live();
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    const rail = html.slice(html.indexOf('data-testid="run-evidence-rail"'));
    const button = rail.match(/<button[^>]*>/)![0];
    expect(button).toContain('min-h-11');
    expect(button).toContain('aria-expanded="false"');
    const phases = now.evidence.phases.filter(p => p.state !== 'skipped');
    const i = phases.findIndex(p => p.state === 'current');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(html).toMatch(new RegExp(`data-testid="run-evidence-head"[^>]*>.*${phases[i].label}.*· ${i + 1} of ${phases.length}`));
    expect(html).not.toContain('run-evidence-list');
  });

  it('no second track: no segment cells and no separate desktop rail', () => {
    const html = renderToStaticMarkup(<NowStrip now={live()} nowMs={20} />);
    expect(html).not.toContain('data-cell=');
    expect(html).not.toContain('run-evidence-compact');
    expect(html.match(/data-testid="lifecycle"/g)).toHaveLength(1);
  });

  it('paused state keeps evidence without a percentage bar', () => {
    const html = renderToStaticMarkup(<PausedBar elapsed="1m" turns={2} tokens={null} />);
    expect(html).toContain('Paused');
    expect(html).not.toContain('progressbar');
  });

  it('the paused bar draws the track paused on its step', () => {
    const html = renderToStaticMarkup(<PausedBar evidence={live().evidence} elapsed="1m" turns={2} tokens={null} />);
    expect(html).toMatch(/data-testid="lifecycle" data-state="waiting"/);
  });
});

describe('runLifecycleState: the run evidence on the Build → Audit → Land track', () => {
  const ev = (over: Record<string, unknown>) => deriveRunEvidence({ status: 'running', createdAt: new Date(0).toISOString(), ...over } as never).phases;

  it('no PR yet: building, or waiting when paused', () => {
    expect(runLifecycleState(ev({}))).toBe('running');
    expect(runLifecycleState(ev({}), { paused: true })).toBe('waiting');
  });

  it('a PR under CI or review is auditing; paused there needs you', () => {
    expect(runLifecycleState(ev({ prNumber: 7, prLifecycleStatus: 'ci_running' }))).toBe('review');
    expect(runLifecycleState(ev({ prNumber: 7, prLifecycleStatus: 'ci_running' }), { paused: true })).toBe('needs_you');
  });

  it('a failed check is CI failed; changes requested is repairing; an escalation needs you', () => {
    expect(runLifecycleState(ev({ prNumber: 7, prLifecycleStatus: 'ci_failed' }))).toBe('ci_failed');
    expect(runLifecycleState(ev({ prNumber: 7, reviewState: 'changes_requested' }))).toBe('fixing');
    expect(runLifecycleState(ev({ prNumber: 7, reviewState: 'escalated' }))).toBe('needs_you');
    expect(runLifecycleState(ev({ prNumber: 7, reviewState: 'review_failed' }))).toBe('recovering');
  });

  it('approved is landing; merged is landed; closed unmerged is not landed', () => {
    expect(runLifecycleState(ev({ prNumber: 7, prLifecycleStatus: 'ci_green', reviewState: 'approved' }))).toBe('landing');
    expect(runLifecycleState(ev({ prNumber: 7, mergedAt: new Date(5).toISOString() }))).toBe('landed');
    expect(runLifecycleState(ev({ prNumber: 7, prLifecycleStatus: 'closed' }))).toBe('not_landed');
  });

  it('an artifact task lands when it delivers', () => {
    expect(runLifecycleState(ev({ outputRequirement: 'artifact_required', deliverableArtifactCount: 1 }))).toBe('landed');
    expect(runLifecycleState(ev({ outputRequirement: 'artifact_required', deliverableArtifactCount: 0 }))).toBe('running');
  });
});
