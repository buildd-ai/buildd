/**
 * A connector's tool classes as a person sees them (connector-tool-review.ts):
 * the settings list (class + where it came from), the toggles' policy, and
 * Home's one card per (connector, tool) refused for want of a read-only mark.
 */
import { describe, expect, it } from 'bun:test';
import {
  classifyWithSource, connectorToolRows, readKeptBlocked, toolSnapshotOf, snapshotSignature,
  unvettedToolNeedsYouItems, withKeptBlocked, connectorToolsHref, type UnvettedRefusalRow,
} from './connector-tool-review';
import { NO_OVERRIDES, readToolOverrides } from './connector-gateway';
import { buildActionQueue } from './action-queue';
import { deriveHomeAttention } from './home-attention';

const CONN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('classifyWithSource', () => {
  it('names where each class came from, in the gateway order', () => {
    const o = { ...NO_OVERRIDES, readOnlyTools: new Set(['marked']), denyTools: new Set(['gone']), vettedReadTools: new Set(['vetted', 'vetted-but-false']) };
    expect(classifyWithSource('gone', { readOnlyHint: true }, o)).toEqual({ cls: 'denied', source: 'admin' });
    expect(classifyWithSource('marked', null, o)).toEqual({ cls: 'read', source: 'admin' });
    expect(classifyWithSource('list_things', { readOnlyHint: true }, o)).toEqual({ cls: 'read', source: 'provider' });
    expect(classifyWithSource('drop_things', { destructiveHint: true }, o)).toEqual({ cls: 'admin', source: 'provider' });
    expect(classifyWithSource('vetted', null, o)).toEqual({ cls: 'read', source: 'catalog' });
    expect(classifyWithSource('vetted-but-false', { readOnlyHint: false }, o)).toEqual({ cls: 'write', source: 'provider' });
    expect(classifyWithSource('otel-getTraceSpans', null, o)).toEqual({ cls: 'write', source: 'default' });
    expect(classifyWithSource('delete_project', null, o).source).toBe('name');
  });
});

describe('tool snapshot', () => {
  it('keeps only the two hints the gateway reads, sorted, and signs the tools not the time', () => {
    const a = toolSnapshotOf(new Map([['b', { readOnlyHint: true, title: 'B' } as never], ['a', null], ['bad name!', null]]), new Date('2026-11-25T00:00:00Z'))!;
    expect(a).toEqual({ at: '2026-11-25T00:00:00.000Z', tools: { a: {}, b: { r: true } } });
    const b = toolSnapshotOf(new Map([['a', null], ['b', { readOnlyHint: true }]]), new Date('2026-11-26T00:00:00Z'))!;
    expect(snapshotSignature(a)).toBe(snapshotSignature(b));
    expect(toolSnapshotOf(new Map(), new Date())).toBeNull();
  });
});

describe('connectorToolRows', () => {
  it('lists snapshot, admin, catalog and refused tools once each, with class and source', () => {
    const meta = {
      toolPolicy: { readOnlyTools: ['otel-x'], denyTools: ['create-monitor'] },
      toolSnapshot: { at: '2026-11-25T00:00:00.000Z', tools: { 'list-datasets': { r: true }, 'otel-x': {}, 'create-monitor': {} } },
    };
    const rows = connectorToolRows(meta, null, ['otel-y']);
    expect(rows.map(r => [r.name, r.cls, r.source, r.adminReadOnly, r.adminDenied, r.listed, r.refused])).toEqual([
      ['create-monitor', 'denied', 'admin', false, true, true, false],
      ['list-datasets', 'read', 'provider', false, false, true, false],
      ['otel-x', 'read', 'admin', true, false, true, false],
      ['otel-y', 'write', 'default', false, false, false, true],
    ]);
  });

  it('a catalog provider adds its vetted reads', () => {
    const rows = connectorToolRows(null, 'axiom');
    const vetted = [...(readToolOverrides(null, 'axiom').vettedReadTools ?? [])];
    expect(vetted.length).toBeGreaterThan(0);
    expect(rows.find(r => r.name === vetted[0])).toMatchObject({ cls: 'read', source: 'catalog' });
  });
});

describe('kept blocked', () => {
  it('adds exact names only', () => {
    expect(withKeptBlocked({ toolReview: { keptBlocked: ['x'] } }, 'otel-y')).toEqual({ keptBlocked: ['otel-y', 'x'] });
    expect(withKeptBlocked(null, '*')).toBeNull();
    expect(withKeptBlocked(null, 42)).toBeNull();
    expect([...readKeptBlocked({ toolReview: { keptBlocked: ['x', 7, '*'] } })]).toEqual(['x']);
  });
});

const refusal = (over: Partial<UnvettedRefusalRow> = {}): UnvettedRefusalRow => ({
  connectorId: CONN, connectorName: 'Axiom', discoveredMetadata: null, provider: 'axiom', tool: 'otel-newTool',
  taskId: 't-1', taskTitle: 'Trace slow checkout', roleSlug: 'builder', workspaceId: 'ws-1', workspaceName: 'web', ...over,
});

describe('unvettedToolNeedsYouItems', () => {
  it('one card per connector and tool, saying who was refused what and why', () => {
    const items = unvettedToolNeedsYouItems([refusal(), refusal({ taskId: 't-2', taskTitle: 'Other' }), refusal({ tool: 'otel-other' })]);
    expect(items.map(i => i.accessToolFix?.tool)).toEqual(['otel-newTool', 'otel-other']);
    expect(items[0]).toMatchObject({
      kind: 'access',
      accessToolFix: { connectorId: CONN, tool: 'otel-newTool', appName: 'Axiom' },
      failureMessage: "Trace slow checkout was refused Axiom otel-newTool because buildd doesn't know it's read-only",
      fixHref: connectorToolsHref(CONN),
      taskId: 't-1',
    });
  });

  it('no card once the tool is read-only, denied or kept blocked', () => {
    expect(unvettedToolNeedsYouItems([refusal({ discoveredMetadata: { toolPolicy: { readOnlyTools: ['otel-newTool'], denyTools: [] } } })])).toEqual([]);
    expect(unvettedToolNeedsYouItems([refusal({ discoveredMetadata: { toolPolicy: { readOnlyTools: [], denyTools: ['otel-newTool'] } } })])).toEqual([]);
    expect(unvettedToolNeedsYouItems([refusal({ discoveredMetadata: { toolReview: { keptBlocked: ['otel-newTool'] } } })])).toEqual([]);
  });

  it('names a role, or an agent, when the task has no title', () => {
    expect(unvettedToolNeedsYouItems([refusal({ taskTitle: null })])[0].failureMessage).toStartWith('A builder agent was refused');
    expect(unvettedToolNeedsYouItems([refusal({ taskTitle: null, roleSlug: null, provider: null, connectorName: 'Custom' })])[0].failureMessage)
      .toBe("An agent was refused Custom otel-newTool because buildd doesn't know it's read-only");
    expect(unvettedToolNeedsYouItems([refusal({ provider: 'connector:Internal', connectorName: 'Internal' })])[0].accessAsk).toBe('Internal otel-newTool');
  });

  it('reaches Home as one ACCESS card keyed by connector and tool', () => {
    const queue = buildActionQueue([...unvettedToolNeedsYouItems([refusal()]), ...unvettedToolNeedsYouItems([refusal()])], []);
    expect(queue.map(q => q.subjectKey)).toEqual([`access-tool:${CONN}/otel-newTool`]);
    expect(queue[0]).toMatchObject({ chip: 'ACCESS', accessToolFix: { tool: 'otel-newTool' } });
    const [item] = deriveHomeAttention({ queue, missions: [], questions: [], held: [], isActionable: () => true });
    expect(item.title).toBe('Axiom otel-newTool');
  });
});
