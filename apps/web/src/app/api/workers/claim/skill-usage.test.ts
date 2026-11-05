/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-3 (R-11..R-13). */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recordSkillUsage } from './skill-usage';

describe('skill usage telemetry', () => {
  it('AC-3: three delivered skills are counted by one atomic upsert', async () => {
    const statements: string[] = [];
    await recordSkillUsage({ teamId: 't', skillIds: ['a', 'b', 'c'], now: new Date(), exec: async (q: string) => { statements.push(q); } });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/ON CONFLICT \(skill_id\) DO UPDATE/i);
    expect(statements[0]).toMatch(/claim_count\s*=\s*skill_usage\.claim_count\s*\+\s*1/i);
  });

  it('AC-3: a failing write does not fail the claim', async () => {
    await expect(recordSkillUsage({
      teamId: 't', skillIds: ['a'], now: new Date(), exec: async () => { throw new Error('db down'); },
    })).resolves.toBeUndefined();
  });

  it('AC-3: no db.transaction() in the usage writer', () => {
    const src = readFileSync(join(import.meta.dir, 'skill-usage.ts'), 'utf8');
    expect(src).not.toMatch(/\.transaction\(/);
  });
});
