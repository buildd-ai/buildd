import { describe, expect, it } from 'bun:test';
import { importedByArea, type SpecIndexInput } from './index-view';

const s = (id: string, o: Partial<SpecIndexInput> = {}): SpecIndexInput => ({
  id, title: id, scope: 'feature', parentSpecId: null, status: 'draft', approvedRevision: null, headRevision: 1, updatedAt: '2026-10-13T00:00:00Z', ...o,
});

describe('importedByArea (§18, R-19): the batches a person confirms, one per area', () => {
  it('groups imported specs by their nearest area, Unfiled last, and leaves out the rest', () => {
    const groups = importedByArea([
      s('billing', { scope: 'domain', title: 'Billing' }),
      s('accounts', { scope: 'domain', title: 'Accounts' }),
      s('invoices', { parentSpecId: 'billing', imported: true, title: 'Invoices' }),
      s('nested', { parentSpecId: 'invoices', imported: true, title: 'Credit notes' }),
      s('login', { parentSpecId: 'accounts', imported: true, title: 'Login' }),
      s('native', { parentSpecId: 'billing', title: 'Native' }),
      s('loose', { imported: true, title: 'Loose' }),
      s('gone', { parentSpecId: 'billing', imported: true, status: 'retired' }),
    ]);
    expect(groups).toEqual([
      { areaId: 'accounts', title: 'Accounts', specs: [{ id: 'login', title: 'Login' }] },
      { areaId: 'billing', title: 'Billing', specs: [{ id: 'nested', title: 'Credit notes' }, { id: 'invoices', title: 'Invoices' }] },
      { areaId: null, title: 'Unfiled', specs: [{ id: 'loose', title: 'Loose' }] },
    ]);
  });

  it('is empty when nothing is imported', () => {
    expect(importedByArea([s('a'), s('b', { scope: 'domain' })])).toEqual([]);
  });
});
