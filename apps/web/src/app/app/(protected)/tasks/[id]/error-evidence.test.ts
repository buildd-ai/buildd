import { describe, expect, it } from 'bun:test';
import type { TraceConsequence } from '@/lib/trace-consequence';
import { affectsLine, buildErrorEvidenceItems, groupErrorEvidence, type ErrorEvidenceItem } from './error-evidence';

const T0 = Date.parse('2026-09-30T14:00:00.000Z');
const at = (sec: number) => new Date(T0 + sec * 1000);

const c = (presentation: TraceConsequence['presentation'], reason = 'why', decidedBy: 'rule' | 'model' = 'rule'): TraceConsequence => ({
  presentation, reason, decidedBy,
});

function build(over: Partial<Parameters<typeof buildErrorEvidenceItems>[0]> = {}) {
  return buildErrorEvidenceItems({
    traces: [],
    consequences: new Map(),
    attemptLabelByWorker: new Map(),
    milestonesByWorker: new Map(),
    ...over,
  });
}

describe('buildErrorEvidenceItems', () => {
  it('parses a bash_nonzero_exit excerpt into command, exit code and output', () => {
    const [item] = build({
      traces: [{ id: 't1', workerId: 'w1', pattern: 'bash_nonzero_exit', excerpt: '$ bun run test foo [exit 1]\n(fail) foo\nerror: x', source: 'Bash', ts: at(0) }],
      consequences: new Map([['t1', c('needs_attention', 'A test run failed and never passed afterwards.')]]),
    });
    expect(item.command).toBe('bun run test foo');
    expect(item.exitCode).toBe(1);
    expect(item.output).toBe('(fail) foo\nerror: x');
    expect(item.presentation).toBe('needs_attention');
    expect(item.reason).toBe('A test run failed and never passed afterwards.');
    expect(item.decidedBy).toBe('rule');
    expect(item.source).toBe('Bash');
    expect(item.ts).toBe('2026-09-30T14:00:00.000Z');
  });

  it('keeps an unknown exit code as null', () => {
    const [item] = build({ traces: [{ id: 't1', workerId: null, pattern: 'bash_nonzero_exit', excerpt: '$ make [exit ?]', source: null, ts: at(0) }] });
    expect(item.command).toBe('make');
    expect(item.exitCode).toBeNull();
    expect(item.output).toBe('');
  });

  it('leaves non-bash traces unparsed: command null, output is the excerpt', () => {
    const [item] = build({ traces: [{ id: 't1', workerId: null, pattern: 'auth_error', excerpt: 'Invalid API key', source: 'assistant', ts: '2026-09-30T14:00:00.000Z' }] });
    expect(item.command).toBeNull();
    expect(item.exitCode).toBeNull();
    expect(item.output).toBe('Invalid API key');
  });

  it('retains the full excerpt untruncated, even at 6000 characters', () => {
    const body = Array.from({ length: 80 }, (_, i) => `line ${i} ${'x'.repeat(66)}`).join('\n').slice(0, 5970);
    const excerpt = `$ bun run test a [exit 1]\n${body}`;
    expect(excerpt.length).toBeGreaterThan(5900);
    const [item] = build({ traces: [{ id: 't1', workerId: null, pattern: 'bash_nonzero_exit', excerpt, source: null, ts: at(0) }] });
    expect(item.excerpt).toBe(excerpt);
    expect(item.output).toBe(body);
  });

  it('defaults a trace with no consequence to unclear', () => {
    const [item] = build({ traces: [{ id: 't1', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(0) }] });
    expect(item.presentation).toBe('unclear');
    expect(item.reason.length).toBeGreaterThan(0);
  });

  it('carries model decisions through', () => {
    const [item] = build({
      traces: [{ id: 't1', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(0) }],
      consequences: new Map([['t1', c('noise', 'Judged exploration noise from the record.', 'model')]]),
    });
    expect(item.decidedBy).toBe('model');
    expect(item.presentation).toBe('noise');
  });

  it('labels the attempt from the worker map, with a fallback', () => {
    const items = build({
      traces: [
        { id: 'a', workerId: 'w1', pattern: 'x', excerpt: 'y', source: null, ts: at(2) },
        { id: 'b', workerId: 'w2', pattern: 'x', excerpt: 'y', source: null, ts: at(1) },
        { id: 'c', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(0) },
      ],
      attemptLabelByWorker: new Map([['w1', 'Attempt 2']]),
    });
    expect(items[0].attempt).toEqual({ label: 'Attempt 2', workerId: 'w1' });
    expect(items[1].attempt.workerId).toBe('w2');
    expect(items[1].attempt.label.length).toBeGreaterThan(0);
    expect(items[2].attempt.workerId).toBeNull();
  });

  it('sorts newest first', () => {
    const items = build({
      traces: [
        { id: 'old', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(0) },
        { id: 'new', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(60) },
        { id: 'mid', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(30).toISOString() },
      ],
    });
    expect(items.map(i => i.id)).toEqual(['new', 'mid', 'old']);
  });

  it('takes up to 4 milestones of the same worker before and after the trace, by ts', () => {
    const ms = [
      ...Array.from({ length: 6 }, (_, i) => ({ type: 'action', label: `before ${i}`, ts: T0 - (6 - i) * 1000 })),
      { type: 'action', tool: 'Bash', cmd: 'grep foo', ts: T0 + 1000 },
      { type: 'status', label: 'after 2', ts: T0 + 2000 },
      { type: 'action', tool: 'Edit', path: 'a.ts', ts: T0 + 3000 },
      { type: 'phase', label: 'after 4', ts: T0 + 4000, toolCount: 1 },
      { type: 'phase', label: 'after 5', ts: T0 + 5000, toolCount: 1 },
      { label: 'no ts' },
      { ts: T0 + 6000 },
    ];
    const [item] = build({
      traces: [{ id: 't1', workerId: 'w1', pattern: 'x', excerpt: 'y', source: null, ts: at(0) }],
      milestonesByWorker: new Map([['w1', ms], ['w2', [{ label: 'other worker', ts: T0 - 1 }]]]),
    });
    expect(item.before.map(l => l.text)).toEqual(['before 2', 'before 3', 'before 4', 'before 5']);
    expect(item.after.map(l => l.text)).toEqual(['$ grep foo', 'after 2', 'Edit a.ts', 'after 4']);
    expect(item.before[0].ts).toBe(new Date(T0 - 4000).toISOString());
  });

  it('has empty context when the worker has no milestones or is unknown', () => {
    const [item] = build({ traces: [{ id: 't1', workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(0) }] });
    expect(item.before).toEqual([]);
    expect(item.after).toEqual([]);
  });

  it('tolerates a non-array milestones value', () => {
    const [item] = build({
      traces: [{ id: 't1', workerId: 'w1', pattern: 'x', excerpt: 'y', source: null, ts: at(0) }],
      milestonesByWorker: new Map([['w1', null as unknown as []]]),
    });
    expect(item.before).toEqual([]);
  });

  it('finds a CI/log link only when the excerpt carries one', () => {
    const items = build({
      traces: [
        { id: 'a', workerId: null, pattern: 'x', excerpt: 'see https://github.com/o/r/actions/runs/123/job/4 for logs', source: null, ts: at(1) },
        { id: 'b', workerId: null, pattern: 'x', excerpt: 'nothing here', source: null, ts: at(0) },
      ],
    });
    expect(items[0].logUrl).toBe('https://github.com/o/r/actions/runs/123/job/4');
    expect(items[1].logUrl).toBeNull();
  });
});

describe('groupErrorEvidence', () => {
  it('splits items by presentation and keeps order', () => {
    const items = build({
      traces: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, workerId: null, pattern: 'x', excerpt: 'y', source: null, ts: at(10 - i) })),
      consequences: new Map([
        ['a', c('needs_attention')], ['b', c('unclear')], ['c', c('recovered')], ['d', c('noise')], ['e', c('recovered')],
      ]),
    });
    const g = groupErrorEvidence(items);
    expect(g.attention.map(i => i.id)).toEqual(['a']);
    expect(g.unclear.map(i => i.id)).toEqual(['b']);
    expect(g.recovered.map(i => i.id)).toEqual(['c', 'e']);
    expect(g.noise.map(i => i.id)).toEqual(['d']);
  });
});

describe('affectsLine', () => {
  const item = (presentation: ErrorEvidenceItem['presentation'], command: string | null, pattern = 'bash_nonzero_exit') =>
    ({ presentation, command, pattern }) as ErrorEvidenceItem;

  it('says what an unrecovered verify failure costs', () => {
    expect(affectsLine(item('needs_attention', 'bun run test foo'))).toBe('Tests did not pass, so the change is not verified.');
    expect(affectsLine(item('needs_attention', 'bunx tsc --noEmit'))).toMatch(/type check/i);
    expect(affectsLine(item('needs_attention', 'bun run lint'))).toMatch(/lint/i);
  });

  it('has a plain line for every presentation', () => {
    for (const p of ['needs_attention', 'unclear', 'recovered', 'noise'] as const) {
      const line = affectsLine(item(p, 'make build'));
      expect(line.length).toBeGreaterThan(10);
      expect(line).not.toContain('—');
    }
    expect(affectsLine(item('needs_attention', null, 'auth_error')).length).toBeGreaterThan(10);
  });
});
