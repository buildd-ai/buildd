/**
 * One open question and what the projection (lib/question-waits.ts) returns
 * for it, for the Home and task page fixtures (Living Spec 1b257609): a
 * repair waits on the answer and a real-machine check after it, one task the
 * viewer cannot see, the schema lane held with two queued, an acceptance-test
 * task's criteria, and the expiry. Invented data, as the projection would
 * return it.
 */
import { optionOutcomes, type QuestionWaits } from '@buildd/core/question-waits';

export const WAITS_FIXTURE_TASK = 'fixture-acceptance-task';

export const WAITS_FIXTURE_QUESTION = {
  type: 'question',
  prompt: 'Accept the acceptance results with two device checks failing?',
  context: 'The acceptance tests for autostart pass everywhere except the two real-machine checks, which fail on the older laptops.',
  options: [
    { label: 'Accept and file the device fix', consequence: 'Ships the tests as they are; the device failures become their own task.', recommended: true, outcome: 'finishes' as const },
    { label: 'Keep testing', consequence: 'Runs the device checks again with more logging first.', outcome: 'continues' as const },
  ],
  recommended: { label: 'Accept and file the device fix', reason: 'Ships the tests as they are; the device failures become their own task.' },
};

export function waitsFixture(now: number): QuestionWaits {
  const base: QuestionWaits = {
    taskId: WAITS_FIXTURE_TASK,
    mission: { id: 'fixture-mission', title: 'Autostart on login' },
    waiting: [
      { id: 'fixture-repair', title: 'Autostart repair', depth: 1, missionId: 'fixture-mission', missionTitle: 'Autostart on login', workspaceName: null, after: null, alsoWaitsOnOther: false },
      { id: 'fixture-device', title: 'Real-machine check', depth: 2, missionId: 'fixture-mission', missionTitle: 'Autostart on login', workspaceName: null, after: { id: 'fixture-repair', title: 'Autostart repair' }, alsoWaitsOnOther: false },
    ],
    hiddenCount: 1,
    beyondCount: 0,
    lanes: [{ lane: 'schema', queued: [{ id: 'fixture-index', title: 'Add login index', position: 2 }, { id: 'fixture-col', title: 'Drop legacy column', position: 3 }], hiddenCount: 0 }],
    criteria: { specId: 'fixture-spec', specTitle: 'Autostart on login', affected: Array.from({ length: 19 }, (_, i) => `R-${i + 1}`), total: 20 },
    askedAt: new Date(now - 30 * 60_000).toISOString(),
    expiresAt: new Date(now + 210 * 60_000).toISOString(),
    onExpiry: { action: 'default', option: 'Accept and file the device fix' },
    options: [],
  };
  return { ...base, options: optionOutcomes(WAITS_FIXTURE_QUESTION.options, base, WAITS_FIXTURE_QUESTION.recommended.label) };
}
