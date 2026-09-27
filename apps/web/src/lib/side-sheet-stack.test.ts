import { beforeEach, describe, expect, it } from 'bun:test';
import { closeAllSheets, getSheetStack, pushSheet, removeSheet, resetSheetStack, sheetPosition, updateSheet } from './side-sheet-stack';

const entry = (id: string, log: string[] = []) => ({ id, title: id, close: () => { log.push(id); removeSheet(id); } });

beforeEach(() => resetSheetStack());

describe('side-sheet stack', () => {
  it('stacks a second sheet on the first; only the top one shows, with Back to the one under it', () => {
    pushSheet(entry('task'));
    pushSheet(entry('records'));
    const s = getSheetStack();
    expect(sheetPosition(s, 'records')).toEqual({ top: true, below: s[0] });
    expect(sheetPosition(s, 'task').top).toBe(false);
  });

  it('Back pops the top sheet and the one under it shows again', () => {
    pushSheet(entry('task'));
    pushSheet(entry('records'));
    removeSheet('records');
    expect(sheetPosition(getSheetStack(), 'task')).toEqual({ top: true, below: null });
  });

  it('a sheet asked to come forward moves to the top instead of duplicating', () => {
    pushSheet(entry('task'));
    pushSheet(entry('records'));
    pushSheet(entry('task'));
    expect(getSheetStack().map(e => e.id)).toEqual(['records', 'task']);
  });

  it('close-all closes every sheet, top first', () => {
    const log: string[] = [];
    pushSheet(entry('task', log));
    pushSheet(entry('records', log));
    closeAllSheets();
    expect(log).toEqual(['records', 'task']);
    expect(getSheetStack()).toEqual([]);
  });

  it('an update keeps the order', () => {
    pushSheet(entry('task'));
    pushSheet(entry('records'));
    updateSheet({ ...entry('task'), title: 'Renamed' });
    expect(getSheetStack().map(e => e.title)).toEqual(['Renamed', 'records']);
  });

  it('a sheet that has not registered yet renders as the top one', () => {
    expect(sheetPosition([], 'new').top).toBe(true);
  });
});
