import { describe, expect, it } from 'bun:test';
import {
  classifyAnalyticsReadFailure, delegationAllows, formatAnalyticsReadFailure, isEvidenceStatus,
  parseScheduleDelegationInput, readScheduleDelegation, SCHEDULE_DELEGATION_MAX_GRANTS,
} from '../schedule-delegation';

const OWN = '00000000-0000-4000-8000-000000000001';
const TARGET = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003';

describe('parseScheduleDelegationInput', () => {
  it('accepts a grant of the two delegable capabilities, deduplicated', () => {
    const r = parseScheduleDelegationInput({ grants: [{ workspaceId: TARGET, capabilities: ['analytics:read', 'tasks:create', 'analytics:read'] }] }, OWN);
    expect(r).toEqual({ ok: true, grants: [{ workspaceId: TARGET, capabilities: ['analytics:read', 'tasks:create'] }] });
  });

  it('null and an empty list both clear it', () => {
    expect(parseScheduleDelegationInput(null, OWN)).toEqual({ ok: true, grants: null });
    expect(parseScheduleDelegationInput({ grants: [] }, OWN)).toEqual({ ok: true, grants: null });
  });

  it('refuses anything that would widen beyond read analytics and create tasks', () => {
    for (const capability of ['admin', 'secrets', 'tasks:write', 'tasks:admin', 'schedules:write', 'knowledge:write', 'workers:write']) {
      expect(parseScheduleDelegationInput({ grants: [{ workspaceId: TARGET, capabilities: [capability] }] }, OWN).ok).toBe(false);
    }
  });

  it('refuses malformed, duplicate, self-referencing, oversized and extra-field input', () => {
    expect(parseScheduleDelegationInput({ grants: [{ workspaceId: 'buildd', capabilities: ['analytics:read'] }] }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput({ grants: [{ workspaceId: OWN, capabilities: ['analytics:read'] }] }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput({ grants: [
      { workspaceId: TARGET, capabilities: ['analytics:read'] }, { workspaceId: TARGET, capabilities: ['tasks:create'] },
    ] }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput({ grants: [{ workspaceId: TARGET, capabilities: [] }] }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput({ grants: [{ workspaceId: TARGET, capabilities: ['analytics:read'], teamId: 'x' }] }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput({ grants: [], grantedByUserId: 'forged' }, OWN).ok).toBe(false);
    expect(parseScheduleDelegationInput([], OWN).ok).toBe(false);
    const many = Array.from({ length: SCHEDULE_DELEGATION_MAX_GRANTS + 1 }, (_, i) => ({
      workspaceId: `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, capabilities: ['analytics:read'],
    }));
    expect(parseScheduleDelegationInput({ grants: many }, OWN).ok).toBe(false);
  });
});

describe('readScheduleDelegation / delegationAllows', () => {
  const stored = { grants: [{ workspaceId: TARGET, capabilities: ['analytics:read'] }], grantedByUserId: 'u', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00Z' };

  it('grants exactly the listed capability on exactly the listed workspace', () => {
    const grants = readScheduleDelegation(stored);
    expect(delegationAllows(grants, TARGET, 'analytics:read')).toBe(true);
    expect(delegationAllows(grants, TARGET, 'tasks:create')).toBe(false);
    expect(delegationAllows(grants, OTHER, 'analytics:read')).toBe(false);
    expect(delegationAllows(grants, null, 'analytics:read')).toBe(false);
  });

  it('a malformed or hand-edited row grants nothing it does not spell out', () => {
    expect(readScheduleDelegation(null)).toEqual([]);
    expect(readScheduleDelegation({ grants: 'all' })).toEqual([]);
    expect(readScheduleDelegation({ grants: [{ workspaceId: '*', capabilities: ['analytics:read'] }] })).toEqual([]);
    expect(readScheduleDelegation({ grants: [{ workspaceId: TARGET, capabilities: ['admin', 'analytics:read'] }] }))
      .toEqual([{ workspaceId: TARGET, capabilities: ['analytics:read'] }]);
  });
});

describe('explicit read outcomes', () => {
  it('only OK and NO_DATA count as evidence', () => {
    expect(isEvidenceStatus('OK')).toBe(true);
    expect(isEvidenceStatus('NO_DATA')).toBe(true);
    for (const s of ['FORBIDDEN', 'UNAUTHORIZED', 'TOOL_UNAVAILABLE'] as const) expect(isEvidenceStatus(s)).toBe(false);
  });

  it('classifies the failures a blind weekly review actually saw', () => {
    expect(classifyAnalyticsReadFailure(new Error('API error: 401 - {"error":"Unauthorized"}'))).toBe('UNAUTHORIZED');
    expect(classifyAnalyticsReadFailure(new Error('API error: 403 - {"error":"A task token cannot read experiment readouts"}'))).toBe('FORBIDDEN');
    expect(classifyAnalyticsReadFailure(new Error('API error: 404 - {"error":"Workspace not found"}'))).toBe('FORBIDDEN');
    expect(classifyAnalyticsReadFailure(new Error('Could not resolve workspace "x": not visible to this key.'))).toBe('FORBIDDEN');
    expect(classifyAnalyticsReadFailure(new Error('API error: 500 - boom'))).toBe('TOOL_UNAVAILABLE');
    expect(classifyAnalyticsReadFailure(new Error('fetch failed'))).toBe('TOOL_UNAVAILABLE');
  });

  it('formats a failure with its status first and an instruction not to read it as zero', () => {
    const text = formatAnalyticsReadFailure(new Error('API error: 401 - nope'), 'decision ledger (question_gate)');
    expect(text.startsWith('UNAUTHORIZED: decision ledger (question_gate) was not read')).toBe(true);
    expect(text).toContain('never as "no issues" or "insufficient sample"');
  });
});
