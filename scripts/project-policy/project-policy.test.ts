import { describe, expect, it } from 'bun:test';
import { extractChangedSubjects, evaluateSubject, policyExitCode } from './pipeline';
import policy from './product-language.json';
import gold from './gold.json';

const file = 'apps/web/src/components/MissionSection.tsx';
const extract = (after: string, before = '') => extractChangedSubjects({ file, before, after });

describe('changed TSX subjects', () => {
  it('rechecks unchanged copy when its static local context changes', () => {
    const before = '<section><h2>Models</h2><p>Manage providers.</p></section>';
    const after = before.replace('Models', 'Agents');
    const rows = extract(after, before);
    expect(rows.find(row => row.after === 'Manage providers.')?.staticContext?.heading).toBe('Agents');
    const diff = '@@ -1 +1 @@\n-<section><h2>Models</h2><p>Manage providers.</p></section>\n+<section><h2>Agents</h2><p>Manage providers.</p></section>';
    expect(extractChangedSubjects({ file, before, after, patch: diff }).some(row => row.after === 'Manage providers.')).toBe(true);
  });
  it('extracts JSX and visible props, including one word labels, with spans and before', () => {
    const before = '<button title="Review">Review changes</button>';
    const rows = extract('<button title="Approve">Approve changes</button>', before);
    expect(rows.map(s => s.after)).toEqual(['Approve', 'Approve changes']);
    expect(rows.map(s => s.before)).toEqual(['Review', 'Review changes']);
    expect(rows.every(s => s.line === 1 && s.end > s.start)).toBe(true);
    expect(rows[1].role).toBe('action');
  });
  it('ignores unchanged copy and non-UI literals, comments, SQL, telemetry and tests', () => {
    expect(extract('<p>Keep this</p>', '<p>Keep this</p>')).toEqual([]);
    expect(extract('const q = sql`select "Your call"`; console.log("Your call"); // Your call\nconst s="Your call";')).toEqual([]);
    expect(extractChangedSubjects({ file: 'src/x.test.tsx', before: '', after: '<button>Your call</button>' })).toEqual([]);
  });
  it('retains dynamic values as unknown, never invented rendered text', () => {
    const s = extract('<p>{mission.description}</p>')[0];
    expect(s.after).toBeNull();
    expect(s.role).toBe('unknown');
  });
  it('does not judge standalone fragments of dynamic or inline sentences', () => {
    const dynamic = extract('<p>Save {name} now.</p>');
    expect(dynamic.every(subject => subject.role === 'unknown')).toBe(true);
    const inline = extract('<p>Do <strong>not</strong> delete.</p>');
    expect(inline.every(subject => subject.role === 'unknown')).toBe(true);
  });
  it('extracts fragment copy and native input hints but excludes non-rendered HTML attributes', () => {
    expect(extract('<>Your call</>')[0].after).toBe('Your call');
    expect(extract('<input placeholder="Your call" />')[0].role).toBe('description');
    expect(extract('<p label="Running" description="Your call" />')).toEqual([]);
    expect(extract('<script>console.log("Running")</script>')).toEqual([]);
  });
  it('extracts only added/modified lines from a supplied diff with full new source', () => {
    const after = '<>\n<p>Old copy</p>\n<button>Your call</button>\n</>';
    const s = extractChangedSubjects({ file, before: '<>\n<p>Old copy</p>\n</>', after,
      patch: '@@ -1,3 +1,4 @@\n <>\n <p>Old copy</p>\n+<button>Your call</button>\n </>' });
    expect(s.map(x => x.after)).toEqual(['Your call']);
    expect(s[0].line).toBe(3);
  });
  it('refuses invalid source rather than reporting clean', () => {
    expect(() => extract('<p title=')).toThrow();
    expect(() => extractChangedSubjects({ file, before: '', after: '<p>Held</p>', patch: 'garbage' })).toThrow();
    expect(() => extractChangedSubjects({ file, before: '', after: '<p>Held</p>', patch: '@@ -0,0 +99 @@\n+<p>Held</p>' })).toThrow();
  });
});

describe('versioned project policy', () => {
  it('does not substitute an unrelated copy-rule example for the actual state', async () => {
    const result = await evaluateSubject(extract('<span>Held</span>')[0], policy);
    expect(result.find(f => f.rule === 'state-jargon')?.suggestedCorrection).toContain('Preserve');
    expect(result.find(f => f.rule === 'state-jargon')?.suggestedCorrection).not.toBe('Waiting for review.');
  });
  it('keeps positive/negative gold controls; heuristic abstention is not a measured semantic pass', async () => {
    for (const row of gold) {
      const result = await evaluateSubject(extract(`<span>${row.text}</span>`)[0], policy,
        { source: 'synthetic gold label', purpose: row.purpose });
      expect(result.some(f => f.reasonCode === 'redundant-sort-narration')).toBe(row.expected === 'redundant');
      if (row.expected !== 'redundant') expect(result.find(f => f.rule === 'semantic-value')?.verdict).toBe('unsupported');
    }
  });
  it.each(['next to start first', 'slipping first', 'oldest first'])('enforces the core sort-subtitle rule for %s', async text => {
    const s = extract(`<span>${text}</span>`)[0];
    const findings = await evaluateSubject(s, policy, { role: 'description', purpose: 'section-subtitle', source: 'MissionGrid SectionView' });
    expect(findings.some(f => f.rule === 'sort-subtitle' && f.verdict === 'revise' && f.enforced)).toBe(true);
    expect(policyExitCode(findings)).toBe(1);
  });
  it.each(['highest priority first', 'largest last'])('advises removal of sort caption %s', async text => {
    const s = extract(`<span>${text}</span>`)[0];
    const findings = await evaluateSubject(s, policy, { role: 'description', purpose: 'section-subtitle', source: 'MissionGrid SectionView' });
    expect(findings.some(f => f.reasonCode === 'redundant-sort-narration' && f.verdict === 'revise' && !f.enforced && f.suggestedCorrection?.includes('Remove'))).toBe(true);
    expect(policyExitCode(findings)).toBe(0);
  });
  it('does not infer a state mismatch from Planning alone', async () => {
    const f = await evaluateSubject(extract('<span>Planning</span>')[0], policy, { role: 'status', source: 'fixture' });
    expect(f.some(x => x.reasonCode === 'missing-state-context' && x.verdict === 'uncertain')).toBe(true);
    expect(policyExitCode(f)).toBe(0);
  });
  it('catches authoritative state mismatch and passes Scheduled with real date', async () => {
    const context = { role: 'status' as const, source: 'waiting projection fixture', state: { kind: 'waiting' as const, value: 'start_deferred' }, scheduledAt: '2027-01-15T12:00:00Z' };
    const bad = await evaluateSubject(extract('<span>Planning</span>')[0], policy, context);
    expect(bad.some(f => f.reasonCode === 'state-label-mismatch' && f.enforced && f.suggestedCorrection === 'Scheduled')).toBe(true);
    expect(policyExitCode(bad)).toBe(1);
    const good = await evaluateSubject(extract('<span>Scheduled</span>')[0], policy, context);
    expect(good.find(f => f.rule === 'state-label')?.verdict).toBe('pass');
    expect(policyExitCode(good)).toBe(0);
  });
  it('keeps unknown state and unknown dynamic strings inconclusive', async () => {
    const unknown = await evaluateSubject(extract('<span>Scheduled</span>')[0], policy,
      { role: 'status', source: 'fixture', state: { kind: 'waiting', value: 'NEW_STATE' } });
    expect(unknown.find(f => f.rule === 'state-label')?.verdict).toBe('uncertain');
    const dynamic = await evaluateSubject(extract('<p>{copy}</p>')[0], policy);
    expect(dynamic.every(f => f.verdict !== 'pass')).toBe(true);
  });
  it('allows real approval action; custom project rule is data, scoped to actions', async () => {
    const good = await evaluateSubject(extract('<button>Approve changes</button>')[0], policy, { source: 'fixture', action: 'approval' });
    expect(policyExitCode(good)).toBe(0);
    const custom = { ...policy, customRules: [{ id: 'workspace-no-call', roles: ['action'], pattern: '^Your call$', correction: 'Choose an action' }] };
    const bad = await evaluateSubject(extract('<button>Your call</button>')[0], custom);
    expect(bad.some(f => f.rule === 'workspace-no-call' && f.enforced)).toBe(true);
    const plain = await evaluateSubject(extract('<h2>Your call</h2>')[0], custom);
    expect(plain.some(f => f.rule === 'workspace-no-call')).toBe(false);
  });
  it('records unavailable semantic evaluation, fingerprints and shared verification evidence', async () => {
    const s = extract('<p>Starts on January 15</p>')[0];
    const a = await evaluateSubject(s, policy);
    const b = await evaluateSubject(s, policy);
    const f = a.find(f => f.rule === 'semantic-value')!;
    expect(f.verdict).toBe('unsupported');
    expect(f.evaluator).toBe('unavailable');
    expect(f.verification.verdict).toBe('unsupported');
    expect(f.inputFingerprint).toBe(b.find(x => x.rule === f.rule)!.inputFingerprint);
    expect(f.policyVersion).toBe(policy.version);
  });
});
