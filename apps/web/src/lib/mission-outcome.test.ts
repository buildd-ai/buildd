import { describe, expect, it } from 'bun:test';
import {
  buildOutcomeHero,
  deliveryLine,
  deriveOutcomeClass,
  missionOutcome,
  nextStoredPrimaryOutcome,
  outcomeExcerpt,
  outcomePool,
  outcomeTaskLine,
  selectPrimaryOutcome,
  validateNomination,
  withPersonPrimaryOutcome,
  type OutcomeArtifactInput,
  type OutcomeHeroInput,
} from './mission-outcome';

const M = 'mission-1';
const CLOSEOUT = 'task-closeout';

const report = (id: string, taskId: string | null = 'task-a', over: Partial<OutcomeArtifactInput> = {}): OutcomeArtifactInput => ({
  id, title: `Report ${id}`, type: 'report', taskId, metadata: {}, ...over,
});

/** The shape of the research mission that triggered this (Navigation AC-19, Mission checks AC-40). */
const researchArtifacts: OutcomeArtifactInput[] = [
  ...Array.from({ length: 9 }, (_, i) => report(`r${i + 1}`, `task-${i + 1}`)),
  report('final', CLOSEOUT, { title: 'Mission final: what to adopt' }),
];

const heroInput = (over: Partial<OutcomeHeroInput> = {}): OutcomeHeroInput => ({
  missionId: M,
  artifacts: researchArtifacts,
  storedPrimary: null,
  closeoutTaskIds: new Set([CLOSEOUT]),
  deliverablePrCount: 0,
  tasks: { merged: 0, done: 8 },
  lede: null,
  primaryContent: '# Mission final\n\nAggregates the read-throughs. No code was produced.\n\n## Verdicts',
  shipped: false,
  target: 'dev',
  release: 'waiting',
  ...over,
});

describe('outcomePool (I-28 pool)', () => {
  it('keeps review artifacts and designs on the mission tasks, in order', () => {
    const pool = outcomePool([
      report('a'),
      { id: 'd', title: 'Nav design', type: 'file', taskId: 'task-a', metadata: { kind: 'design' } },
      { id: 'shot', title: 'Home', type: 'screenshot', taskId: 'task-a', metadata: { qa: { route: '/' } } },
      { id: 'plan', title: 'Plan', type: 'impl_plan', taskId: 'task-a' },
      report('shipped', 'task-a', { key: `mission-shipped-${M}` }),
      report('latest', 'task-a', { key: `mission-${M}` }),
      report('orphan', null),
    ], M);
    expect(pool.map(a => [a.id, a.kind])).toEqual([['a', 'report'], ['d', 'design']]);
  });

  it('reads a Living Spec body as a spec', () => {
    expect(outcomePool([report('s', 'task-a', { type: 'content', metadata: { livingSpec: true } })], M)[0].kind).toBe('spec');
  });
});

describe('selectPrimaryOutcome (I-28 order, AC-38)', () => {
  const pool = outcomePool(researchArtifacts, M);
  const closeoutTaskIds = new Set([CLOSEOUT]);

  it('keeps a stored choice that is in the pool, with its source', () => {
    expect(selectPrimaryOutcome({ stored: { artifactId: 'r3', source: 'person' }, pool, deliverablePrCount: 0, closeoutTaskIds })).toMatchObject({ artifact: { id: 'r3' }, source: 'person' });
    expect(selectPrimaryOutcome({ stored: { artifactId: 'r4', source: 'author' }, pool, deliverablePrCount: 2, closeoutTaskIds })).toMatchObject({ artifact: { id: 'r4' }, source: 'author' });
  });

  it('ignores a stored choice whose artifact is gone and falls to the closeout report', () => {
    expect(selectPrimaryOutcome({ stored: { artifactId: 'deleted', source: 'person' }, pool, deliverablePrCount: 0, closeoutTaskIds })).toMatchObject({ artifact: { id: 'final' }, source: 'closeout' });
  });

  it('takes the closeout report only with no deliverable PR', () => {
    expect(selectPrimaryOutcome({ stored: null, pool, deliverablePrCount: 0, closeoutTaskIds })?.artifact.id).toBe('final');
    expect(selectPrimaryOutcome({ stored: null, pool, deliverablePrCount: 3, closeoutTaskIds })).toBeNull();
  });

  it('gives none when the closeout task produced two reports or none, even with a newer artifact', () => {
    const two = outcomePool([...researchArtifacts, report('final-2', CLOSEOUT)], M);
    expect(selectPrimaryOutcome({ stored: null, pool: two, deliverablePrCount: 0, closeoutTaskIds })).toBeNull();
    const none = outcomePool(researchArtifacts.filter(a => a.taskId !== CLOSEOUT), M);
    expect(selectPrimaryOutcome({ stored: null, pool: none, deliverablePrCount: 0, closeoutTaskIds })).toBeNull();
  });
});

describe('nomination (I-28 rule 2, AC-38)', () => {
  const pool = outcomePool(researchArtifacts, M);

  it('keeps a nomination only when it is in the pool', () => {
    expect(validateNomination('r2', pool)).toEqual({ artifactId: 'r2', source: 'author' });
    expect(validateNomination('not-in-pool', pool)).toBeNull();
    expect(validateNomination(42, pool)).toBeNull();
  });

  it("keeps a person's choice over a later completion's nomination", () => {
    expect(nextStoredPrimaryOutcome({ artifactId: 'r1', source: 'person', chosenBy: 'Sam' }, 'r2', pool))
      .toEqual({ artifactId: 'r1', source: 'person', chosenBy: 'Sam' });
    expect(nextStoredPrimaryOutcome({ artifactId: 'r1', source: 'author' }, 'r2', pool)).toEqual({ artifactId: 'r2', source: 'author' });
    expect(nextStoredPrimaryOutcome(null, 'nope', pool)).toBeNull();
  });
});

describe('deriveOutcomeClass (I-27, AC-37)', () => {
  const classOf = (artifacts: OutcomeArtifactInput[], deliverablePrCount: number, storedPrimary: unknown = null) =>
    missionOutcome({ missionId: M, artifacts, storedPrimary, closeoutTaskIds: new Set([CLOSEOUT]), deliverablePrCount }).class;

  it('maps the five fixtures to the five classes', () => {
    expect(classOf(researchArtifacts, 0)).toBe('research');
    expect(classOf([report('notes')], 5)).toBe('code');
    expect(classOf([report('finding')], 3, { artifactId: 'finding', source: 'author' })).toBe('mixed');
    expect(classOf([report('spec', 'task-a', { type: 'content', metadata: { livingSpec: true } })], 0, { artifactId: 'spec', source: 'author' })).toBe('spec');
    expect(classOf([], 0)).toBe('none');
  });

  it('reads a research mission with reports but no primary as research', () => {
    expect(classOf([report('a'), report('b')], 0)).toBe('research');
  });

  it('does not read a task kind or the mission title', () => {
    // Nothing but PR facts and the selection go in: the signature itself is the guard.
    expect(deriveOutcomeClass({ deliverablePrCount: 0, primary: null, pool: [] })).toBe('none');
  });
});

describe('outcomeExcerpt (R-23)', () => {
  it('quotes the first plain paragraph without markdown marks', () => {
    expect(outcomeExcerpt('# Title\n\n- a list\n\nThe **first** [paragraph](http://x) here.\n\nSecond.')).toBe('The first paragraph here.');
  });

  it('cuts at 240 characters on a word', () => {
    const long = Array.from({ length: 80 }, () => 'word').join(' ');
    const out = outcomeExcerpt(long)!;
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith('…')).toBe(true);
  });

  it('gives nothing for an empty or heading-only body', () => {
    expect(outcomeExcerpt(null)).toBeNull();
    expect(outcomeExcerpt('# Only\n\n## Headings')).toBeNull();
  });
});

describe('words (R-24, R-26, I-29)', () => {
  it('counts tasks done, merged, or both', () => {
    expect(outcomeTaskLine({ merged: 0, done: 8 })).toBe('8 tasks done');
    expect(outcomeTaskLine({ merged: 5, done: 3 })).toBe('5 merged · 3 done');
    expect(outcomeTaskLine({ merged: 16, done: 0 })).toBe('16 tasks merged');
  });

  it('keeps delivered and deployed apart', () => {
    expect(deliveryLine({ shipped: true, target: 'dev', release: 'waiting' })).toBe('Delivered into dev · release queued');
    expect(deliveryLine({ shipped: true, target: 'dev', release: 'healthy', releaseLabel: 'v0.318' })).toBe('Delivered into dev · deployed v0.318');
    expect(deliveryLine({ shipped: true, target: 'dev', release: 'failed' })).toBe('Delivered into dev · release failed');
    expect(deliveryLine({ shipped: true, target: 'dev', release: 'not_configured' })).toBe('Delivered into dev');
    expect(deliveryLine({ shipped: false, target: 'dev', release: 'waiting' })).toBe('Work complete · not delivered');
  });
});

describe('buildOutcomeHero (R-23 to R-26)', () => {
  it('leads the research mission with its closeout report, excerpt and Open report', () => {
    const hero = buildOutcomeHero(heroInput())!;
    expect(hero.class).toBe('research');
    expect(hero.words).toBe('Outcome ready');
    expect(hero.primary).toMatchObject({ id: 'final', source: 'closeout', action: 'Open report', href: `/app/missions/${M}?artifact=final` });
    expect(hero.lede).toBe('Aggregates the read-throughs. No code was produced.');
    expect(hero.ledeIsExcerpt).toBe(true);
    expect(hero.supportingCount).toBe(9);
    expect(hero.taskLine).toBe('8 tasks done');
    expect(hero.delivery).toBeNull();
    expect(hero.pipelineApplies).toBe(false);
  });

  it('prefers the What shipped lede over the excerpt', () => {
    const hero = buildOutcomeHero(heroInput({ lede: 'Eight agent harnesses were read and each got a verdict.' }))!;
    expect(hero.lede).toBe('Eight agent harnesses were read and each got a verdict.');
    expect(hero.ledeIsExcerpt).toBe(false);
  });

  it('with no primary lists every report, closeout first, and promotes none (R-25, AC-20)', () => {
    const artifacts = [report('a', 'task-1'), report('b', 'task-2'), report('c', 'task-3')];
    const hero = buildOutcomeHero(heroInput({ artifacts, closeoutTaskIds: new Set(['task-2', 'task-3']) }))!;
    expect(hero.words).toBe('Outcome ready · 3 reports');
    expect(hero.primary).toBeNull();
    expect(hero.reports.map(r => r.id)).toEqual(['b', 'c', 'a']);
    expect(hero.supportingCount).toBe(0);
  });

  it('shows both facts for a mixed mission (AC-22)', () => {
    const hero = buildOutcomeHero(heroInput({
      artifacts: [report('finding')], storedPrimary: { artifactId: 'finding', source: 'author' },
      deliverablePrCount: 3, tasks: { merged: 3, done: 0 }, shipped: true,
    }))!;
    expect(hero.class).toBe('mixed');
    expect(hero.words).toBe('Outcome ready');
    expect(hero.delivery).toBe('Delivered into dev · release queued');
    expect(hero.pipelineApplies).toBe(true);
    expect(buildOutcomeHero(heroInput({
      artifacts: [report('finding')], storedPrimary: { artifactId: 'finding', source: 'author' },
      deliverablePrCount: 3, shipped: true, release: 'healthy', releaseLabel: 'v0.318',
    }))!.delivery).toBe('Delivered into dev · deployed v0.318');
  });

  it('names a spec outcome by its approval state and opens it as a spec', () => {
    const hero = buildOutcomeHero(heroInput({
      artifacts: [report('s', 'task-a', { type: 'content', metadata: { livingSpec: true } })],
      storedPrimary: { artifactId: 's', source: 'author' }, specApproval: 'awaiting_approval',
    }))!;
    expect(hero.class).toBe('spec');
    expect(hero.primary?.action).toBe('Open spec');
    expect(hero.specState).toBe('Awaiting approval');
  });

  it('leaves code and none missions to the page as it was (AC-23)', () => {
    expect(buildOutcomeHero(heroInput({ artifacts: [report('notes')], deliverablePrCount: 5, shipped: true }))).toBeNull();
    expect(buildOutcomeHero(heroInput({ artifacts: [] }))).toBeNull();
  });
});

describe("withPersonPrimaryOutcome (I-28 rule 1)", () => {
  const meta = { kind: 'mission_shipped_report', shipped: { version: 1, lede: null, completedAt: 'x', primaryOutcome: { artifactId: 'a', source: 'author' } } };

  it("sets a person's choice and keeps the rest of the record", () => {
    const next = withPersonPrimaryOutcome(meta, { artifactId: 'b', chosenBy: 'user:u-1' });
    expect(next.kind).toBe('mission_shipped_report');
    expect((next.shipped as any).primaryOutcome).toEqual({ artifactId: 'b', source: 'person', chosenBy: 'user:u-1' });
    expect((next.shipped as any).completedAt).toBe('x');
    expect((meta.shipped as any).primaryOutcome.artifactId).toBe('a');
  });

  it('clears it', () => {
    expect('primaryOutcome' in (withPersonPrimaryOutcome(meta, null).shipped as object)).toBe(false);
  });
});
