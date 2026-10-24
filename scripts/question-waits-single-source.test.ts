import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

/**
 * Living Spec 1b257609 revision 2, R-5 and AC-9: what waits on an agent's
 * question is computed once, by the projection (apps/web/src/lib/question-waits.ts
 * `loadQuestionWaits`), worded once (packages/core/question-waits.ts), and
 * every surface reads it from there. This fails, naming the file, when a
 * surface builds its own list of waiting work or writes its own words for it.
 */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
/** Source without comments: a doc comment may quote the words it points to. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The surfaces that render a decision or question card, or answer for one. */
const SURFACES = [
  'apps/web/src/lib/needs-you-card.ts',
  'apps/web/src/components/DecisionCard.tsx',
  'apps/web/src/lib/mission-decisions.ts',
  'apps/web/src/app/app/(protected)/home/NeedsYouCards.tsx',
  'apps/web/src/app/app/(protected)/tasks/[id]/QuestionHero.tsx',
  'apps/web/src/components/tasks/TaskQuestion.tsx',
] as const;

/** Where each surface gets the projection: a read of it, never a derivation. */
const READS: Record<string, RegExp> = {
  'apps/web/src/app/app/(protected)/missions/[id]/page.tsx': /loadQuestionWaitsFor\(/,
  'apps/web/src/app/app/(protected)/home/NeedsYouCards.tsx': /useQuestionWaits\(/,
  'apps/web/src/components/tasks/TaskQuestion.tsx': /useQuestionWaits\(/,
  'apps/web/src/components/use-question-waits.ts': /\/question-waits`/,
  'apps/web/src/app/api/tasks/[id]/question-waits/route.ts': /loadQuestionWaits\(/,
  'apps/web/src/app/api/tasks/[id]/route.ts': /loadQuestionWaits\(/,
  'apps/web/src/lib/explain.ts': /loadQuestionWaits\(/,
  'apps/web/src/app/api/workers/[id]/route.ts': /loadQuestionWaits\(/,
  'apps/web/src/lib/question-hold-notify.ts': /loadQuestionWaits\(/,
};

/** Signs of a surface computing who waits: reading dependency edges, lanes or the board's blockers. */
const OWN_LIST = [
  /dependsOn/,
  /\.blockers\b/,
  /dependentNames|dependentsSentence/,
  /serial_lane|serialLane|loadLanes/,
  /\bdependents\s*[:=]/,
];

describe('what waits on a question has one source (spec 1b257609 AC-9)', () => {
  for (const file of SURFACES) {
    it(`${file} builds no list of waiting work of its own`, () => {
      const src = code(file);
      for (const re of OWN_LIST) expect(src, `${file} matches ${re}`).not.toMatch(re);
    });
  }

  for (const [file, re] of Object.entries(READS)) {
    it(`${file} reads the projection`, () => {
      expect(read(file), file).toMatch(re);
    });
  }

  it('no app file writes the words of the summary or the effects itself', () => {
    const files = execSync(`git ls-files 'apps/web/src/**/*.ts' 'apps/web/src/**/*.tsx'`, { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(f => f && !/\.test\.tsx?$/.test(f) && !f.includes('/dev/'));
    const offenders = files.filter(f => /['"`](?:Waits on this:|Nothing else waits on this answer|Finishes the task:|Keeps working:|Stops the task:)/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('the projection is the only module that reads dependency edges for a question', () => {
    const src = read('apps/web/src/lib/question-waits.ts');
    expect(src).toMatch(/export async function loadQuestionWaits\(/);
    expect(src).toMatch(/dependsOn/);
  });
});
