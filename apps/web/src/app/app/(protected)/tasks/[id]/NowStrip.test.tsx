import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { deriveRunEvidence } from '@buildd/core/run-evidence';
import NowStrip, { PausedBar, RunEvidenceRail, runLifecycleState } from './NowStrip';
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

  it('the phase evidence sits behind a 44px disclosure, closed by default, naming the head phase as step n of m (never a bare n of m, which reads as code-review progress)', () => {
    const now = live();
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    const rail = html.slice(html.indexOf('data-testid="run-evidence-rail"'));
    const button = rail.match(/<button[^>]*>/)![0];
    expect(button).toContain('min-h-11');
    expect(button).toContain('aria-expanded="false"');
    const phases = now.evidence.phases.filter(p => p.state !== 'skipped');
    const i = phases.findIndex(p => p.state === 'current');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(html).toMatch(new RegExp(`data-testid="run-evidence-head"[^>]*>.*${phases[i].label}.*· step ${i + 1} of ${phases.length}`));
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

// Task d483085c: the expanded list is a timeline on design-system tokens, one
// marker shape per evidence kind so it reads in greyscale (artifact f6e57302).
describe('expanded evidence list', () => {
  const t0 = new Date(0).toISOString();
  const open = (over: Record<string, unknown>, nowMs = 60 * 60_000) => {
    const evidence = deriveRunEvidence({ status: 'running', createdAt: t0, ...over } as never);
    return renderToStaticMarkup(<RunEvidenceRail evidence={evidence} nowMs={nowMs} defaultOpen />);
  };
  const rows = (html: string) => [...html.matchAll(/<li [^>]*data-phase="([^"]+)"[^>]*>(.*?)<\/li>/g)];
  const markerOf = (html: string, phase: string) =>
    html.match(new RegExp(`data-phase="${phase}"[^>]*>.*?data-testid="run-evidence-marker"[^>]*data-kind="([^"]+)"`))?.[1];

  // The reported screenshot: Commit reported by the agent, everything after it not seen.
  const reported = () => open({ startedAt: t0, filesChanged: 3, dirtyWorktree: true, milestones: [{ type: 'checkpoint', event: 'first_commit', ts: 10 }] });

  it('keeps all nine facts, their words and their order', () => {
    const html = reported();
    expect(rows(html).map(r => r[1])).toEqual(['claimed', 'started', 'changed', 'committed', 'pushed', 'pr_open', 'ci', 'review', 'merged']);
    expect(html).toContain('Run evidence · <b');
    expect(html).toMatch(/step 4 of 9/);
  });

  it('one marker kind per evidence: observed done, reported done, not seen', () => {
    const html = reported();
    expect(markerOf(html, 'started')).toBe('done');
    expect(markerOf(html, 'committed')).toBe('reported');
    expect(markerOf(html, 'pushed')).toBe('unknown');
    expect(html).toMatch(/data-phase="committed"[^>]*aria-label="Commit, done, reported"/);
    expect(html).toMatch(/data-phase="committed".*?· reported/);
    // A step with no evidence says so in words, never only by its marker.
    expect(rows(html).filter(r => r[1] !== 'claimed' && r[1] !== 'started' && r[1] !== 'changed' && r[1] !== 'committed').every(r => r[2].includes('not seen'))).toBe(true);
  });

  it('the live step is marked current for assistive tech and drawn in the live hue', () => {
    const html = open({ startedAt: t0, dirtyWorktree: true, commitCount: 0, lastCommitSha: null, usesReviewer: true });
    expect(html).toMatch(/data-phase="committed"[^>]*aria-current="step"/);
    expect(markerOf(html, 'committed')).toBe('current');
    const list = html.slice(html.indexOf('data-testid="run-evidence-list"'));
    expect(list.match(/aria-current="step"/g)).toHaveLength(1);
    expect(markerOf(html, 'review')).toBe('todo');
  });

  it('a failed step draws the failed marker', () => {
    const html = open({ startedAt: t0, prNumber: 7, prLifecycleStatus: 'ci_failed' });
    expect(markerOf(html, 'ci')).toBe('failed');
  });

  it('design-system geometry: one 1px axis, 3px-radius markers, no 2px rule, compact rows', () => {
    const html = reported();
    const list = html.slice(html.indexOf('data-testid="run-evidence-list"'));
    expect(list).not.toContain('border-l-2');
    expect(list).not.toContain('border-2');
    // One segment per row, all on the same 1px line, so they draw one axis.
    const axis = [...list.matchAll(/data-testid="run-evidence-axis"[^>]*class="([^"]+)"/g)].map(m => m[1].split(' '));
    expect(axis).toHaveLength(9);
    for (const a of axis) expect(a).toEqual(expect.arrayContaining(['absolute', 'left-[7px]', 'w-px', 'bg-border-strong']));
    for (const m of list.matchAll(/data-testid="run-evidence-marker"[^>]*class="([^"]+)"/g)) {
      expect(m[1].split(' ')).toContain('rounded-sm');
    }
    for (const li of list.matchAll(/<li [^>]*data-tier="(history|future)"[^>]*class="([^"]+)"/g)) {
      expect(li[2].split(' ')).toContain('h-7');
      expect(li[2]).not.toContain('min-h-11');
    }
  });

  it('the disclosure toggle stays 44px below md', () => {
    const html = reported();
    const button = html.slice(html.indexOf('data-testid="run-evidence-rail"')).match(/<button[^>]*>/)![0];
    expect(button).toContain('min-h-11');
    expect(button).toContain('aria-expanded="true"');
  });
});

// Task 7b83507d: the open list has an information hierarchy. The head phase
// (the one the summary line names) is the current step, set larger with what
// the evidence says about it; history above it is compact, the future muted.
describe('expanded evidence list: current step, history, future', () => {
  const t0 = new Date(0).toISOString();
  const open = (over: Record<string, unknown>, nowMs = 60 * 60_000) =>
    renderToStaticMarkup(<RunEvidenceRail evidence={deriveRunEvidence({ status: 'running', createdAt: t0, ...over } as never)} nowMs={nowMs} defaultOpen />);
  const tiers = (html: string) => Object.fromEntries([...html.matchAll(/<li [^>]*data-phase="([^"]+)"[^>]*data-tier="([^"]+)"/g)].map(m => [m[1], m[2]]));
  const currentWords = (html: string) => html.match(/data-testid="run-evidence-current-words"[^>]*>([^<]*)</)?.[1];
  const row = (html: string, phase: string) => html.match(new RegExp(`<li [^>]*data-phase="${phase}".*?</li>`))![0];

  const reported = { startedAt: t0, filesChanged: 3, dirtyWorktree: true, milestones: [{ type: 'checkpoint', event: 'first_commit', ts: 10 * 60_000 }] };
  const live = { startedAt: t0, dirtyWorktree: true, commitCount: 0, lastCommitSha: null, usesReviewer: true };
  const failed = { startedAt: t0, prNumber: 7, prLifecycleStatus: 'ci_failed', usesReviewer: true };

  it('exactly one current step, the phase the summary line names; history before it, future after', () => {
    expect(tiers(open(reported))).toEqual({
      claimed: 'history', started: 'history', changed: 'history', committed: 'head',
      pushed: 'future', pr_open: 'future', ci: 'future', review: 'future', merged: 'future',
    });
    const html = open(failed);
    expect(html).toMatch(/Run evidence · <b[^>]*>Review<\/b> · step 8 of 9/);
    expect(tiers(html)).toMatchObject({ ci: 'history', review: 'head', merged: 'future' });
    expect(html.match(/data-testid="run-evidence-current"/g)).toHaveLength(1);
  });

  it('the current step is set larger and heavier than every other row', () => {
    const html = open(live);
    expect(row(html, 'committed')).toMatch(/class="[^"]*\btext-title font-semibold\b[^"]*text-accent-text[^"]*">Commit</);
    for (const p of ['claimed', 'started', 'pushed', 'review']) expect(row(html, p)).not.toContain('text-title');
    expect(row(html, 'committed')).toContain('w-[15px] h-[15px]');
    expect(row(html, 'claimed')).toContain('w-[11px] h-[11px]');
  });

  it('says what the evidence says about it, in the list\'s own words: working, done · observed, done · reported, failed', () => {
    expect(currentWords(open(live))).toBe('working');
    expect(currentWords(open(reported))).toBe('done · reported');
    expect(currentWords(open({ startedAt: t0, dirtyWorktree: true, commitCount: 1, lastCommitSha: 'abc', status: 'completed' }))).toBe('done · observed');
    expect(currentWords(open({ startedAt: t0, prNumber: 7, prLifecycleStatus: 'ci_running' }))).toBe('running');
    expect(currentWords(open({ startedAt: t0, prNumber: 7, reviewState: 'changes_requested' }))).toBe('changes requested · observed');
    // The head says "reported" once, in its words line, not again after the label.
    expect(row(open(reported), 'committed').replace(/<[^>]*>/g, ' ').match(/reported/g)).toHaveLength(1);
  });

  it('every state reads in words without colour: history ink, future muted, reported, failed and not seen spelled out', () => {
    const html = open(failed);
    expect(row(html, 'pr_open')).toMatch(/text-text-primary">PR</);
    expect(row(html, 'ci')).toMatch(/text-status-error">CI<span[^>]*> · failed</);
    expect(row(html, 'merged')).toMatch(/text-text-muted">Merged<span[^>]*> · not seen</);
    expect(row(open(reported), 'pushed')).toContain(' · not seen');
    expect(row(open({ startedAt: t0, filesChanged: 3, commitCount: 1, lastCommitSha: 'abc', usesReviewer: true }), 'changed')).toMatch(/text-text-primary">Changes<span[^>]*> · reported</);
  });

  it('times sit in one fixed left column, right-aligned in tabular figures, on every row', () => {
    const html = open(reported);
    const cells = [...html.matchAll(/data-testid="run-evidence-time"[^>]*class="([^"]+)"[^>]*>([^<]*)</g)];
    expect(cells).toHaveLength(9);
    for (const [, cls] of cells) expect(cls.split(' ')).toEqual(expect.arrayContaining(['text-right', 'tabular-nums', 'whitespace-nowrap']));
    expect(cells.map(c => c[2])).toEqual(['1h ago', '1h ago', '', '50m ago', '', '', '', '', '']);
    for (const li of html.matchAll(/<li [^>]*class="([^"]+)"/g)) expect(li[1]).toContain('grid-cols-[56px_15px_minmax(0,1fr)]');
  });

  it('the axis starts at the first marker and stops at the last one', () => {
    const html = open(reported);
    const axis = [...html.matchAll(/data-testid="run-evidence-axis"[^>]*class="([^"]+)"/g)].map(m => m[1]);
    expect(axis[0]).toContain('top-3.5 bottom-0');
    expect(axis.at(-1)).toContain('top-0 h-3.5');
    expect(axis[3]).toContain('top-0 bottom-0');
    // A run whose head is the last phase ends the axis at the head marker's centre.
    const merged = open({ startedAt: t0, status: 'completed', commitCount: 1, lastCommitSha: 'abc', prNumber: 7, mergedAt: new Date(0).toISOString() });
    expect([...merged.matchAll(/data-testid="run-evidence-axis"[^>]*class="([^"]+)"/g)].at(-1)![1]).toContain('top-0 h-[22px]');
  });
});

describe('Now card chrome', () => {
  it('is the 1px .card, with no retired 2px frame, offset shadow or accent bar', () => {
    const html = renderToStaticMarkup(<NowStrip now={live()} nowMs={20} />);
    const section = html.match(/<section[^>]*>/)![0];
    expect(section).toMatch(/class="card\b/);
    expect(html).not.toContain('border-2');
    expect(html).not.toContain('card-shadow');
    expect(html).not.toContain('w-[6px]');
    const paused = renderToStaticMarkup(<PausedBar elapsed="1m" turns={2} tokens={null} />);
    expect(paused).toMatch(/data-testid="worker-paused-bar" class="card\b/);
    expect(paused).not.toContain('border-2');
  });

  it('the live mark stops pulsing under reduced motion', () => {
    const html = renderToStaticMarkup(<NowStrip now={live()} nowMs={20} />);
    for (const m of html.matchAll(/class="([^"]*animate-status-pulse[^"]*)"/g)) expect(m[1]).toContain('motion-reduce:animate-none');
  });
});

describe('runLifecycleState: the run evidence on the Build → Verify → Deliver track', () => {
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

// U1 audit (task 01e6293b): with no update yet the strip read "Working…" under
// an outcome row that already said the task is in progress.
describe('Now strip before the first update', () => {
  it('does not restate the status', () => {
    const now = deriveNow([], { status: 'running', currentAction: null, startMs: 0, nowMs: 20, prUrl: null, filesChanged: 0, commitCount: 0 } as never);
    const html = renderToStaticMarkup(<NowStrip now={now} nowMs={20} />);
    expect(html).not.toMatch(/worker-now-headline[^>]*>[^<]*Working/);
    expect(html).toContain('worker-now-headline');
  });
});
