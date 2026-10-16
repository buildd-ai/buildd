import { describe, expect, it } from 'bun:test';
import * as contract from './index';
import {
  VERDICTS, checkCriteriaScope, contentHash, foldGovernedOutcome, frozenCopyHash, inScope, isVerdict,
  normalizeFrozenCopy, specCriteria, criterionChecks,
  type ApprovalRecord, type SpecPin, type SpecSourceAdapter, type SpecVerdict, type SourceVersion,
} from './index';

// The contract as a copier sees it: one import, the rules work end to end with
// no host. Rule-by-rule cases live in requirements/scope/check-lines tests.

const BODY = [
  '# Totals',
  '- **D-1** Prices come from the catalogue.',
  '- **R-1** Totals are in the shopper\'s currency.',
  '  check: `bun test fx`',
  '- **AC-1** Given a cart in EUR, the total reads in EUR.',
  '- **AC-2** An empty cart shows the empty state.',
].join('\n');

describe('the portable contract', () => {
  it('exports every rule from one entry point', () => {
    for (const name of ['requirementIds', 'specCriteria', 'criterionChecks', 'checkCriteriaScope', 'inScope', 'foldGovernedOutcome', 'contentHash', 'normalizeFrozenCopy', 'frozenCopyHash']) {
      expect(typeof (contract as Record<string, unknown>)[name]).toBe('function');
    }
    expect(VERDICTS).toEqual(['pass', 'fail', 'inconclusive', 'unsupported']);
  });

  it('parses, scopes, checks and folds a spec with no host', () => {
    const criteria = specCriteria(BODY).map((c) => c.id);
    expect(criteria).toEqual(['R-1', 'AC-1', 'AC-2']);
    expect(criterionChecks(BODY)).toEqual([{ criterionId: 'R-1', command: 'bun test fx' }]);

    const scope = checkCriteriaScope(['ac-1', 'AC-2'.replace('2', '02')], criteria, 3);
    expect(scope).toEqual({ ok: false, error: expect.stringContaining('ac-1') });
    const ok = checkCriteriaScope(['AC-01', 'AC-2', 'AC-2'], criteria, 3);
    expect(ok).toEqual({ ok: true, criteria: ['AC-1', 'AC-2'] });

    const pin: SpecPin = { specId: 's', specRevisionId: 'r3', revision: 3, contentHash: 'h', criteria: ['AC-1', 'AC-2'] };
    const answers = inScope(pin as unknown as Record<string, unknown>, specCriteria(BODY)).map((c) => c.id);
    expect(answers).toEqual(['AC-1', 'AC-2']);

    const head = 'a'.repeat(40);
    const verdicts: SpecVerdict[] = [
      { taskId: 't', specRevisionId: 'r3', criterionId: 'AC-1', verdict: 'pass', headSha: head, evidence: [{ kind: 'screenshot', ref: 'shot-1' }], checker: 'visual' },
      { taskId: 't', specRevisionId: 'r3', criterionId: 'AC-2', verdict: 'pass', headSha: head, evidence: [{ kind: 'screenshot', ref: 'shot-2' }], checker: 'visual' },
    ];
    const at = (i: number) => new Date(Date.UTC(2026, 9, 12, 0, i)).toISOString();
    const folded = foldGovernedOutcome(answers, verdicts.map((v, i) => ({ ...v, at: at(i) })), head);
    expect(folded.outcome).toBe('verified');
    // The newest verdict per criterion stands, whichever checker wrote it.
    const later = foldGovernedOutcome(answers, [...verdicts.map((v, i) => ({ ...v, at: at(i) })), { criterionId: 'AC-2', verdict: 'fail' as const, headSha: head, at: at(9) }], head);
    expect(later).toMatchObject({ outcome: 'fail', reason: 'AC-2 failed' });
    // Never a pass by default.
    expect(foldGovernedOutcome(answers, [], head).outcome).toBe('unverified');
    expect(foldGovernedOutcome([], [], head).outcome).toBe('unverified');
  });

  it('only buildd verdict words are verdicts', () => {
    expect(isVerdict('inconclusive')).toBe(true);
    expect(isVerdict('unclear')).toBe(false);
    expect(isVerdict('ok')).toBe(false);
  });

  it('hashes text exactly, and an external copy after normalizing it', async () => {
    expect(await contentHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await contentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const saved = '\r\n# Spec  \r\n\r\n\r\n- **AC-1** Works.  \r\n```\nkeep  \n\n\n```\n\n';
    expect(normalizeFrozenCopy(saved)).toBe('# Spec\n\n- **AC-1** Works.\n```\nkeep\n\n\n```\n');
    expect(await frozenCopyHash(saved)).toBe(await frozenCopyHash('# Spec\n\n- **AC-1** Works.\n```\nkeep\n\n\n```'));
    expect(await frozenCopyHash(saved)).not.toBe(await frozenCopyHash('# Spec\n\n- **AC-1** Works!\n```\nkeep\n\n\n```'));
  });

  it('a home is four operations, implementable with no host', async () => {
    const versions = new Map<string, string>([['1', '- **AC-1** One.'], ['2', '- **AC-1** One.\n- **AC-2** Two.']]);
    const memory: SpecSourceAdapter = {
      kind: 'git',
      async readVersion(ref, version) {
        const body = versions.get(version);
        return body === undefined ? null : { source: { kind: 'git', ref, version }, body, contentHash: await contentHash(body) } satisfies SourceVersion;
      },
      async listVersions(ref) { return [...versions.keys()].reverse().map((version) => ({ source: { kind: 'git' as const, ref, version } })); },
      async proposeChange(ref, change) {
        const latest = [...versions.keys()].pop()!;
        return change.baseVersion === latest ? { ok: true, proposal: { kind: 'git', ref, version: `proposal-of-${latest}` } } : { ok: false, reason: 'stale', currentVersion: latest };
      },
      async versionsSince(ref, since) { return [...versions.keys()].filter((v) => Number(v) > Number(since)).map((version) => ({ kind: 'git' as const, ref, version })); },
    };
    const v2 = await memory.readVersion('o/r:spec.md', '2');
    expect(v2 && specCriteria(v2.body).map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
    expect(await memory.readVersion('o/r:spec.md', '9')).toBeNull();
    expect(await memory.proposeChange('o/r:spec.md', { body: 'x', summary: 's', baseVersion: '1' })).toEqual({ ok: false, reason: 'stale', currentVersion: '2' });
    expect(await memory.versionsSince('o/r:spec.md', '1')).toEqual([{ kind: 'git', ref: 'o/r:spec.md', version: '2' }]);

    const approval: ApprovalRecord = { specId: 's', revision: 2, source: v2!.source, contentHash: v2!.contentHash, design: { kind: 'artifact', ref: 'design-1', version: '4', screens: [{ id: '/cart', name: 'Cart' }] }, approvedBy: 'person-1', approvedAt: '2026-10-12T00:00:00Z' };
    expect(approval.design?.screens?.[0]?.id).toBe('/cart');
  });
});
