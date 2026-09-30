import { describe, it, expect } from 'bun:test';
import {
  planningOutputSchema,
  shippedOutputSchema,
  shippedPromptText,
  taskOutcomeLine,
} from '@buildd/shared';
import {
  buildHeroPool,
  buildShippedRecord,
  changeTypeFromManifests,
  checkLede,
  classifyChangedPaths,
  isShippedRecordCurrent,
  parseShippedRecord,
  pickHeroShots,
  renderShippedMarkdown,
  trimOffPlan,
  type ShippedHeroShot,
} from './mission-shipped';
import type { VisualShot } from './mission-visual-review';

const GOOD_LEDE = 'On a phone, the home screen now opens on what needs you. Checked at phone and desktop width.';

function shot(id: string, route: string, viewport: 'mobile' | 'desktop', verdict: 'ok' | 'issue' | 'unsure', at = '2026-01-02T00:00:00Z'): VisualShot {
  return { id, createdAt: at, src: `/s/${id}`, workerId: 'w1', qa: { runKey: 'run-1', route, viewport, finding: '', verdict } };
}

function poolShot(id: string, route: string, viewport: 'mobile' | 'desktop'): ShippedHeroShot {
  return { artifactId: id, route, viewport, verdict: 'ok' };
}

const POOL = [
  poolShot('d-home', '/app/home', 'desktop'),
  poolShot('m-tasks', '/app/tasks', 'mobile'),
  poolShot('m-home', '/app/home', 'mobile'),
  poolShot('d-tasks', '/app/tasks', 'desktop'),
];

const base = {
  authorTaskId: 'author-1',
  manual: false,
  changeType: 'frontend' as const,
  pool: POOL,
  sensitive: false,
  completedAt: '2026-01-02T00:00:00.000Z',
};

describe('changeType', () => {
  it('frontend when only UI surface files changed', () => {
    expect(classifyChangedPaths(['apps/web/src/app/app/home/page.tsx', 'apps/web/src/components/Card.tsx'])).toBe('frontend');
  });

  it('backend when only non-UI code changed', () => {
    expect(classifyChangedPaths(['apps/web/src/app/api/tasks/route.ts', 'packages/core/db/schema.ts'])).toBe('backend');
  });

  it('both when UI and non-UI code changed', () => {
    expect(classifyChangedPaths(['apps/web/src/components/Card.tsx', 'packages/core/db/schema.ts'])).toBe('both');
  });

  it('null when nothing changed, or only docs and generated files', () => {
    expect(classifyChangedPaths([])).toBeNull();
    expect(classifyChangedPaths(['docs/design/x.md', 'README.md', 'notes.txt', 'packages/core/drizzle/meta/_journal.json'])).toBeNull();
  });

  it('docs beside code do not turn a frontend change into both', () => {
    expect(classifyChangedPaths(['apps/web/src/components/Card.tsx', 'docs/design/x.md'])).toBe('frontend');
  });

  it('classifies declared manifests when PR files are unavailable', () => {
    expect(changeTypeFromManifests([['apps/web/src/components/Card.tsx'], ['packages/core/db/schema.ts']])).toBe('both');
  });

  it('ignores the repo-wide sentinel manifest and missing manifests', () => {
    expect(changeTypeFromManifests([['**'], null, undefined])).toBeNull();
    expect(changeTypeFromManifests([['**'], ['apps/web/src/components/Card.tsx']])).toBe('frontend');
  });
});

describe('checkLede', () => {
  it('accepts plain sentences', () => {
    expect(checkLede(GOOD_LEDE)).toEqual({ ok: true, lede: GOOD_LEDE });
    expect(checkLede('Release pull requests are no longer closed by mistake when a follow-up fix fails. One planned cleanup was dropped.').ok).toBe(true);
  });

  it('accepts everyday slashes, brand names and versions', () => {
    for (const ok of [
      'Works on iPhone and GitHub, and/or by email, 24/7.',
      'The Next.js upgrade is done and nothing looks different.',
      'Pages load in 1000000 fewer milliseconds than it defaced before.',
    ]) {
      expect(checkLede(ok).ok).toBe(true);
    }
  });

  it('collapses whitespace', () => {
    expect(checkLede('  One   two\nthree  ')).toEqual({ ok: true, lede: 'One two three' });
  });

  it('rejects a missing, non-string, or empty lede', () => {
    expect(checkLede(undefined)).toEqual({ ok: false, reason: 'missing' });
    expect(checkLede(42)).toEqual({ ok: false, reason: 'missing' });
    expect(checkLede('   ')).toEqual({ ok: false, reason: 'empty' });
  });

  it('rejects a lede over the length limit', () => {
    expect(checkLede('a '.repeat(121)).ok).toBe(false);
    expect(checkLede('x'.repeat(240)).ok).toBe(true);
    expect(checkLede('x'.repeat(241)).ok).toBe(false);
  });

  it('rejects file paths', () => {
    for (const bad of [
      'Changed apps/web/src/page so it fits.',
      'Edited the settings in ./config and moved on.',
      'Now served from /api/tasks instead.',
      'Updated schema.ts to match.',
    ]) {
      expect(checkLede(bad).ok).toBe(false);
    }
  });

  it('rejects backticks, PR numbers, UUIDs and commit hashes', () => {
    expect(checkLede('Fixed the `home` card.').ok).toBe(false);
    expect(checkLede('Fixed in #1234 for good.').ok).toBe(false);
    expect(checkLede('See 8237cfa9-1111-4222-8333-444455556666 for more.').ok).toBe(false);
    expect(checkLede('Reverted by a1b2c3d4e5 yesterday.').ok).toBe(false);
  });

  it('rejects symbol names', () => {
    for (const bad of [
      'The ProviderOnboardingCard no longer pushes content down.',
      'Now hasActionableWork hides the card.',
      'Uses closeAncestorRetryPrs correctly.',
      'The retry_count is reset.',
      'Calls refresh() after saving.',
    ]) {
      expect(checkLede(bad).ok).toBe(false);
    }
  });
});

describe('trimOffPlan', () => {
  it('keeps at most two lines and cuts long ones', () => {
    const lines = trimOffPlan(['one', 'two', 'three']);
    expect(lines).toEqual(['one', 'two']);
    const long = trimOffPlan(['y'.repeat(300)])[0];
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
  });

  it('drops blanks and non-strings, and tolerates a non-array', () => {
    expect(trimOffPlan(['  ', 3, null, 'kept'])).toEqual(['kept']);
    expect(trimOffPlan(undefined)).toEqual([]);
    expect(trimOffPlan('text')).toEqual([]);
  });
});

describe('hero shots', () => {
  it('pool is the latest run without issue verdicts', () => {
    const shots = [
      shot('old', '/app/old', 'mobile', 'ok', '2026-01-01T00:00:00Z'),
      { ...shot('new-ok', '/app/home', 'mobile', 'ok'), qa: { runKey: 'run-2', route: '/app/home', viewport: 'mobile' as const, finding: '', verdict: 'ok' as const } },
      { ...shot('new-bad', '/app/tasks', 'mobile', 'issue'), qa: { runKey: 'run-2', route: '/app/tasks', viewport: 'mobile' as const, finding: '', verdict: 'issue' as const } },
      { ...shot('new-unsure', '/app/team', 'desktop', 'unsure'), qa: { runKey: 'run-2', route: '/app/team', viewport: 'desktop' as const, finding: '', verdict: 'unsure' as const } },
    ];
    expect(buildHeroPool(shots).map(s => s.artifactId).sort()).toEqual(['new-ok', 'new-unsure']);
  });

  it('keeps nominated ids inside the pool and drops the rest', () => {
    const picked = pickHeroShots(['d-tasks', 'not-in-pool', 'm-home', 42], POOL);
    expect(picked.map(s => s.artifactId)).toEqual(['d-tasks', 'm-home']);
  });

  it('never repeats a nominated shot and keeps at most three', () => {
    const picked = pickHeroShots(['m-home', 'm-home', 'm-tasks', 'd-home', 'd-tasks'], POOL);
    expect(picked.map(s => s.artifactId)).toEqual(['m-home', 'm-tasks', 'd-home']);
  });

  it('falls back to a deterministic pick, mobile first, when nothing valid is nominated', () => {
    const expected = ['m-home', 'm-tasks', 'd-home'];
    expect(pickHeroShots(undefined, POOL).map(s => s.artifactId)).toEqual(expected);
    expect(pickHeroShots(['ghost'], [...POOL].reverse()).map(s => s.artifactId)).toEqual(expected);
  });

  it('is empty when there is no pool', () => {
    expect(pickHeroShots(['a'], [])).toEqual([]);
  });
});

describe('buildShippedRecord — the fallbacks table', () => {
  const authored = { lede: GOOD_LEDE, heroShots: ['d-tasks'], offPlan: ['One cleanup was dropped.', 'b', 'c'] };

  it('author present: lede, nominated shots and trimmed off-plan are kept', () => {
    const { record, ledeRejection } = buildShippedRecord({ ...base, authorShipped: authored });
    expect(ledeRejection).toBeNull();
    expect(record).toMatchObject({
      version: 1,
      lede: GOOD_LEDE,
      origin: 'author',
      authorTaskId: 'author-1',
      changeType: 'frontend',
      offPlan: ['One cleanup was dropped.', 'b'],
    });
    expect(record.heroShots.map(s => s.artifactId)).toEqual(['d-tasks']);
  });

  it('no shots: the record has no hero shots', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: authored, pool: [] });
    expect(record.heroShots).toEqual([]);
    expect(record.lede).toBe(GOOD_LEDE);
  });

  it('author missing: no lede, no off-plan, server-picked shots, origin no_author', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: null });
    expect(record.lede).toBeNull();
    expect(record.offPlan).toEqual([]);
    expect(record.origin).toBe('no_author');
    expect(record.heroShots.map(s => s.artifactId)).toEqual(['m-home', 'm-tasks', 'd-home']);
  });

  it('author with no shipped output (fallback-only author is passed as null by the store): same as missing', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: undefined, authorTaskId: 'author-1' });
    expect(record.origin).toBe('no_author');
    expect(record.authorTaskId).toBe('author-1');
  });

  it('manual: no lede, no author, mechanical facts only', () => {
    const { record } = buildShippedRecord({ ...base, manual: true, authorTaskId: 'ignored', authorShipped: authored });
    expect(record).toMatchObject({ origin: 'manual', lede: null, authorTaskId: null, offPlan: [], changeType: 'frontend' });
    expect(record.heroShots.map(s => s.artifactId)).toEqual(['m-home', 'm-tasks', 'd-home']);
  });

  it('lede fails the check: lede, nominations and off-plan are all ignored, and the reason is reported', () => {
    const { record, ledeRejection } = buildShippedRecord({
      ...base,
      authorShipped: { lede: 'Fixed ProviderOnboardingCard spacing in apps/web/src/components.', heroShots: ['d-tasks'], offPlan: ['x'] },
    });
    expect(ledeRejection).not.toBeNull();
    expect(record.lede).toBeNull();
    expect(record.origin).toBe('no_author');
    expect(record.offPlan).toEqual([]);
    expect(record.heroShots.map(s => s.artifactId)).toEqual(['m-home', 'm-tasks', 'd-home']);
  });

  it('PR files unavailable: the change type the store passes in (from manifests, or null) is stored as given', () => {
    expect(buildShippedRecord({ ...base, authorShipped: authored, changeType: null }).record.changeType).toBeNull();
    expect(buildShippedRecord({ ...base, authorShipped: authored, changeType: 'backend' }).record.changeType).toBe('backend');
  });

  it('sensitive workspace: no lede and no off-plan, only change type and shot ids', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: authored, sensitive: true });
    expect(record.lede).toBeNull();
    expect(record.offPlan).toEqual([]);
    expect(record.changeType).toBe('frontend');
    expect(record.heroShots.map(s => s.artifactId)).toEqual(['d-tasks']);
  });

  it('reopened: a record from an earlier completion is no longer current', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: authored });
    expect(isShippedRecordCurrent(record, '2026-01-02T00:00:00.000Z')).toBe(true);
    expect(isShippedRecordCurrent(record, new Date('2026-01-02T00:00:00.000Z'))).toBe(true);
    expect(isShippedRecordCurrent(record, '2026-02-01T00:00:00.000Z')).toBe(false);
    expect(isShippedRecordCurrent(record, null)).toBe(false);
    expect(isShippedRecordCurrent(record, 'not a date')).toBe(false);
  });
});

describe('record helpers', () => {
  it('parseShippedRecord accepts only a version-1 record', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: { lede: GOOD_LEDE } });
    expect(parseShippedRecord(JSON.parse(JSON.stringify(record)))).toEqual(record);
    expect(parseShippedRecord({ ...record, version: 2 })).toBeNull();
    expect(parseShippedRecord(null)).toBeNull();
    expect(parseShippedRecord([])).toBeNull();
  });

  it('renders a short markdown summary', () => {
    const { record } = buildShippedRecord({ ...base, authorShipped: { lede: GOOD_LEDE, offPlan: ['One cleanup was dropped.'] } });
    const md = renderShippedMarkdown(record);
    expect(md).toContain(GOOD_LEDE);
    expect(md).toContain('Change type: frontend');
    expect(md).toContain('- One cleanup was dropped.');
  });
});

describe('shared contract', () => {
  it('the planning schema carries an optional shipped definition (the evaluation schema is covered in mission-evaluation.test.ts)', () => {
    const planning = planningOutputSchema as unknown as { properties: Record<string, unknown>; required: string[] };
    expect(planning.properties.shipped).toBe(shippedOutputSchema);
    expect(planning.required).not.toContain('shipped');
    expect(shippedOutputSchema.required).toEqual(['lede']);
  });

  it('prompt text names the trigger and carries the examples', () => {
    expect(shippedPromptText('planning')).toContain('When you set missionComplete');
    expect(shippedPromptText('evaluation')).toContain('When you return verdict "complete"');
    for (const text of [shippedPromptText('planning'), shippedPromptText('evaluation')]) {
      expect(text.match(/^BAD:/gm)).toHaveLength(2);
      expect(text.match(/^GOOD:/gm)).toHaveLength(2);
      expect(text).toContain('Max 240 characters');
    }
  });

  it('taskOutcomeLine prefers the handoff, then a real summary, and skips captured text', () => {
    expect(taskOutcomeLine({ summary: 's', structuredOutput: { handoff: { delivered: 'D' } } })).toEqual({ kind: 'handoff', text: 'D' });
    expect(taskOutcomeLine({ summary: ' real ' })).toEqual({ kind: 'summary', text: 'real' });
    expect(taskOutcomeLine({ summary: 'captured', summarySource: 'fallback' })).toBeNull();
    expect(taskOutcomeLine({ summary: 'reaped', reaperAutoCompleted: true })).toBeNull();
    expect(taskOutcomeLine({ summary: 'x', summarySource: 'fallback', structuredOutput: { handoff: { delivered: 'D' } } })).toEqual({ kind: 'handoff', text: 'D' });
    expect(taskOutcomeLine(null)).toBeNull();
    expect(taskOutcomeLine({})).toBeNull();
  });
});
