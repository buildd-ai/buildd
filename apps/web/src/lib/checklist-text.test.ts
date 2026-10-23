import { describe, expect, it } from 'bun:test';
import { LEGACY_MANIFEST_ITEM, MANIFEST_ITEM, repairChecklist } from './checklist-text';

describe('stored organizer checklist repair', () => {
  it('replaces only the verbatim item and keeps surrounding instructions', () => {
    expect(repairChecklist(`custom start\n${LEGACY_MANIFEST_ITEM}\ncustom end`)).toEqual({
      kind: 'updated', text: `custom start\n${MANIFEST_ITEM}\ncustom end`,
    });
  });
  it('is idempotent', () => {
    const first = repairChecklist(LEGACY_MANIFEST_ITEM);
    expect(first.kind).toBe('updated');
    expect(repairChecklist(first.text).kind).toBe('current');
  });
  it('leaves customized items and absent checklists alone', () => {
    for (const text of [null, '', LEGACY_MANIFEST_ITEM + ' custom', LEGACY_MANIFEST_ITEM.replace('CONCRETE', 'specific')]) {
      expect(repairChecklist(text)).toEqual({ kind: 'custom', text });
    }
  });
  it('preserves CRLF', () => {
    expect(repairChecklist(`start\r\n${LEGACY_MANIFEST_ITEM}\r\nend`).text).toBe(`start\r\n${MANIFEST_ITEM}\r\nend`);
  });
});
