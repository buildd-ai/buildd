import { describe, expect, test } from 'bun:test';
import { extractTenantContext } from '../../src/tenant-context';

// Tenant context only names the tenant in the prompt. It carries no credential:
// buildd does not store, decrypt or hand out a subscription login.
describe('extractTenantContext', () => {
  test('returns the tenant named on the task context', () => {
    const ctx = extractTenantContext({ tenantContext: { tenantId: 't-1', displayName: 'Acme', dispatchUrl: 'https://dispatch.example' } });
    expect(ctx).toEqual({ tenantId: 't-1', displayName: 'Acme', dispatchUrl: 'https://dispatch.example' });
  });

  test('null without a tenant id, and for an empty or missing context', () => {
    expect(extractTenantContext(null)).toBeNull();
    expect(extractTenantContext(undefined)).toBeNull();
    expect(extractTenantContext({})).toBeNull();
    expect(extractTenantContext({ tenantContext: { displayName: 'x' } })).toBeNull();
  });
});
