import { describe, it, expect } from 'bun:test';
import { TaskCategory } from '@buildd/shared';
import { classifyTask } from './task-category';

/**
 * Keyword classifier. Titles here are fictional but shaped like real filings.
 * The research rule is the risky one: "investigate", "explore" and "compare"
 * are everyday words, so it has to fire on the task's own framing (the title's
 * leading verb or its conventional prefix) and never on a bug investigation.
 */

describe('TaskCategory', () => {
  it('includes research', () => {
    expect(TaskCategory.RESEARCH).toBe('research');
  });
});

describe('classifyTask — research', () => {
  const research: Array<[string, string?]> = [
    ['Research FX rate providers and compare pricing tiers'],
    ['Investigate options for storing invoice PDFs'],
    ['Explore replacing the polling loop with server-sent events'],
    ['Evaluate hosted vector databases for semantic search'],
    ['Compare Postgres full-text search with a dedicated search service'],
    ['Look into whether we can drop the Redis dependency'],
    ['Spike: websocket vs SSE for live board updates'],
    ['research(billing): how do other tools meter seats?'],
    ['Research why trial users churn in their first week'],
    ['Assess feasibility of offline mode for the mobile app'],
    // A research title whose description happens to mention a bug word is
    // still research — the description does not get to override the framing.
    ['Research FX rate providers', 'The current one returns an error for some currency pairs, so we want alternatives.'],
  ];

  for (const [title, description] of research) {
    it(`"${title}" → research`, () => {
      expect(classifyTask(title, description)).toBe('research');
    });
  }
});

describe('classifyTask — research does not steal other work', () => {
  const cases: Array<[string, string | null, string | null]> = [
    // Bug investigations stay bugs.
    ['Investigate why the uploader crashes on large files', null, 'bug'],
    ['Investigate why nightly deploys fail', null, 'bug'],
    ['Investigate why some users see duplicate invoices', null, 'bug'],
    ['Look into the 500 error on the login page', null, 'bug'],
    ['Investigate flaky checkout e2e test', null, 'bug'],
    ['Investigate why the dashboard is slow to load', null, 'bug'],
    ['Evaluate fix options for the session regression', null, 'bug'],
    // The word appears, but the work is building or changing something.
    ['Add a compare view to the pricing page', null, 'feature'],
    ['Add research tab to the workspace sidebar', null, 'feature'],
    ['Fix compare button alignment', null, 'bug'],
    ['Add retry to the webhook sender', 'Investigate whether upstream supports idempotency keys first.', 'feature'],
    ['Implement CSV export', 'Explore the existing report code before starting.', 'feature'],
    // A conventional prefix naming another type wins over a research verb.
    ['docs: compare deployment options in the README', null, 'docs'],
    // Reviewing a change is review work, not research — and the keyword
    // classifier still never emits review.
    ['Review PR for the rates cache', null, null],
  ];

  for (const [title, description, expected] of cases) {
    it(`"${title}" → ${expected}`, () => {
      expect(classifyTask(title, description)).toBe(expected as any);
    });
  }
});

describe('classifyTask — existing categories unchanged', () => {
  const cases: Array<[string, string | null]> = [
    ['Fix crash when saving settings', 'bug'],
    ['Update README with setup steps', 'docs'],
    ['Add e2e coverage for the invite flow', 'test'],
    ['Move deploy pipeline to the new runner image', 'infra'],
    ['Tighten card layout on the board', 'design'],
    ['Refactor the claim route into smaller helpers', 'refactor'],
    ['Bump drizzle to the latest minor', 'chore'],
    ['Implement per-workspace rate limits', 'feature'],
    ['Something vague', null],
  ];

  for (const [title, expected] of cases) {
    it(`"${title}" → ${expected}`, () => {
      expect(classifyTask(title)).toBe(expected as any);
    });
  }
});
