import { describe, expect, it } from 'bun:test';
import type { WorkspaceReadinessItem } from '@buildd/shared';
import {
  draftToAnswers,
  emptySpecDraft,
  initialWorkspaceId,
  isSelectable,
  missionHref,
  orderedItems,
  rowTone,
  selectableItemIds,
  statusLabel,
} from './onboarding-view';

const item = (over: Partial<WorkspaceReadinessItem>): WorkspaceReadinessItem => ({
  id: 'test-command',
  label: 'Test command',
  status: 'missing',
  importance: 'core',
  evidence: [],
  fix: { kind: 'scaffold', summary: 'Add it', templateId: 't' },
  ...over,
});

describe('rowTone / statusLabel', () => {
  it('maps each status', () => {
    expect(rowTone(item({ status: 'detected' }))).toBe('ok');
    expect(rowTone(item({ status: 'unknown' }))).toBe('info');
    expect(rowTone(item({ status: 'missing', importance: 'core' }))).toBe('warning');
    expect(rowTone(item({ status: 'missing', importance: 'recommended' }))).toBe('muted');
    expect(statusLabel(item({ status: 'detected' }))).toBe('Found');
    expect(statusLabel(item({ status: 'unknown' }))).toBe('Could not tell');
    expect(statusLabel(item({ status: 'missing' }))).toBe('Missing');
  });

  it('a waiver wins over the status', () => {
    const w = item({ status: 'missing', waived: { reason: 'n/a', at: '2026-01-01T00:00:00.000Z' } });
    expect(rowTone(w)).toBe('muted');
    expect(statusLabel(w)).toBe('Waived');
  });
});

describe('isSelectable', () => {
  it('only missing, unwaived, scaffold-fixable rows', () => {
    expect(isSelectable(item({}))).toBe(true);
    expect(isSelectable(item({ status: 'detected' }))).toBe(false);
    expect(isSelectable(item({ status: 'unknown' }))).toBe(false);
    expect(isSelectable(item({ fix: { kind: 'apply-config', summary: 'x' } }))).toBe(false);
    expect(isSelectable(item({ fix: { kind: 'owner-decision', summary: 'x' } }))).toBe(false);
    expect(isSelectable(item({ fix: null }))).toBe(false);
    expect(isSelectable(item({ waived: { reason: 'n/a', at: '2026-01-01T00:00:00.000Z' } }))).toBe(false);
  });

  it('selectableItemIds lists them in report order', () => {
    const items = [item({ id: 'agent-instructions' }), item({ id: 'test-command', status: 'detected' }), item({ id: 'spec-root' })];
    expect(selectableItemIds({ items })).toEqual(['agent-instructions', 'spec-root']);
  });
});

describe('orderedItems', () => {
  it('core first, stable within a group', () => {
    const items = [
      item({ id: 'spec-root', importance: 'recommended' }),
      item({ id: 'test-command' }),
      item({ id: 'agent-instructions', importance: 'recommended' }),
      item({ id: 'build-command' }),
    ];
    expect(orderedItems(items).map((i) => i.id)).toEqual(['test-command', 'build-command', 'spec-root', 'agent-instructions']);
  });
});

describe('missionHref', () => {
  it('deep-links the new-mission form with the workspace preselected', () => {
    expect(missionHref('ws 1')).toBe('/app/missions/new?workspace=ws%201');
  });
});

describe('initialWorkspaceId', () => {
  const list = [{ id: 'a' }, { id: 'b' }];
  it('the link beats the last-used workspace', () => {
    expect(initialWorkspaceId(list, 'b', 'a')).toBe('b');
  });
  it('ignores a requested workspace the viewer cannot see', () => {
    expect(initialWorkspaceId(list, 'zzz', 'a')).toBe('a');
    expect(initialWorkspaceId(list, 'zzz', null)).toBe('');
  });
  it('a lone workspace is chosen without a hint', () => {
    expect(initialWorkspaceId([{ id: 'a' }], null, null)).toBe('a');
  });
  it('several workspaces and no hint leaves it unchosen', () => {
    expect(initialWorkspaceId(list, null, null)).toBe('');
  });
});

describe('draftToAnswers', () => {
  it('splits lines, trims, and omits empty optional lists', () => {
    const d = emptySpecDraft();
    d.title = ' Example ';
    d.description = 'A thing';
    d.capabilities[0] = {
      name: ' Charge once ',
      invariants: 'never twice\n\n  always logged ',
      accepted: { given: '', when: 'pay', then: 'one charge' },
      rejected: { given: 'paid', when: 'pay again', then: 'refused' },
      codePaths: '',
    };
    d.outOfScope = 'refunds';
    const a = draftToAnswers(d);
    expect(a.title).toBe('Example');
    expect(a.capabilities[0].name).toBe('Charge once');
    expect(a.capabilities[0].invariants).toEqual(['never twice', 'always logged']);
    expect(a.capabilities[0].accepted).toEqual({ when: 'pay', then: 'one charge' });
    expect(a.capabilities[0].codePaths).toBeUndefined();
    expect(a.outOfScope).toEqual(['refunds']);
    expect(a.verification).toBeUndefined();
    expect(a.protectedAreas).toBeUndefined();
  });
});
