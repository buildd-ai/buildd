import { describe, test, expect } from 'bun:test';
import { taskClientLabel, acpClient } from './task-client';

describe('taskClientLabel', () => {
  test('names the ACP client from its initialize clientInfo', () => {
    expect(taskClientLabel({ client: { kind: 'acp', name: 'T3 Code' } })).toBe('from T3 Code');
  });
  test('another client is labelled as itself', () => {
    expect(taskClientLabel({ client: { kind: 'acp', name: 'Zed' } })).toBe('from Zed');
  });
  test('an ACP client with no name is still generic, not T3', () => {
    expect(taskClientLabel({ client: { kind: 'acp' } })).toBe('from an ACP client');
  });
  test('absent or malformed marker gives nothing', () => {
    expect(taskClientLabel({})).toBeNull();
    expect(taskClientLabel(null)).toBeNull();
    expect(taskClientLabel({ client: 'T3 Code' })).toBeNull();
    expect(taskClientLabel({ client: { kind: 'other', name: 'x' } })).toBeNull();
  });
  test('the name is clipped and stripped of control characters', () => {
    const label = taskClientLabel({ client: { kind: 'acp', name: 'A\u0000B' + 'x'.repeat(200) } })!;
    expect(label.includes('\u0000')).toBe(false);
    expect(label.length).toBeLessThan(80);
  });
});

describe('acpClient', () => {
  test('builds the marker from clientInfo', () => {
    expect(acpClient({ name: ' T3 Code ', version: '1' })).toEqual({ kind: 'acp', name: 'T3 Code' });
    expect(acpClient(undefined)).toEqual({ kind: 'acp' });
    expect(acpClient({ name: 5 })).toEqual({ kind: 'acp' });
  });
});
