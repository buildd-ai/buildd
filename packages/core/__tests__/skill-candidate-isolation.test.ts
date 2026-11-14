/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-7 (R-8). */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillCandidates } from '../db/schema';
import { SKILL_CANDIDATE_STATES } from '../skill-candidate-transition';

const root = join(import.meta.dir, '..', '..', '..');
const readers = [
  'packages/core/memory-retrieval.ts',
  'apps/web/src/app/api/workers/claim/skill-and-role-injection.ts',
  'apps/web/src/lib/schedule-skill-preflight.ts',
  'apps/web/src/app/api/workers/claim/context-injection.ts',
];

describe('skill candidate isolation', () => {
  it('AC-7: candidates live in their own table, in every state', () => {
    expect(skillCandidates).toBeDefined();
    expect([...SKILL_CANDIDATE_STATES].sort()).toEqual(['candidate', 'dismissed', 'expired', 'promoted']);
  });

  it('AC-7: recall, claim push, attachSkillBundles and the pre-flight never read the table', () => {
    for (const f of readers) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src).not.toMatch(/skillCandidates|skill_candidates/);
    }
  });
});
