import { describe, expect, it } from 'bun:test';
import { requestingPerson } from './request-person';

describe('requestingPerson', () => {
  it('a dashboard session is the signed-in person', () => {
    expect(requestingPerson({ id: 'u-1' }, null)).toBe('u-1');
  });

  it('an OAuth session is the person behind it', () => {
    expect(requestingPerson(null, { sessionUserId: 'u-2' })).toBe('u-2');
  });

  it('an API key is never a person, whatever its level', () => {
    expect(requestingPerson(null, { level: 'admin' })).toBeNull();
    expect(requestingPerson(null, { sessionUserId: null })).toBeNull();
    expect(requestingPerson(null, { sessionUserId: '' })).toBeNull();
  });

  it('a per-task token is never a person, even if the account names a session user', () => {
    expect(requestingPerson(null, { sessionUserId: 'u-2', taskScope: { taskId: 't' } })).toBeNull();
  });

  it('a key that rides along with a browser cookie still acts as the key', () => {
    expect(requestingPerson({ id: 'u-1' }, { sessionUserId: null })).toBeNull();
  });

  it('an OAuth session on an agent grant is never a person, even if a session user is attached', () => {
    expect(requestingPerson(null, { actsAs: 'agent', oauthUserId: 'u-3' })).toBeNull();
    expect(requestingPerson(null, { actsAs: 'agent', sessionUserId: 'u-3' })).toBeNull();
    expect(requestingPerson(null, { actsAs: 'person', sessionUserId: 'u-3' })).toBe('u-3');
  });

  it('no caller is no person', () => {
    expect(requestingPerson(null, null)).toBeNull();
    expect(requestingPerson({ id: '' }, undefined)).toBeNull();
  });
});
