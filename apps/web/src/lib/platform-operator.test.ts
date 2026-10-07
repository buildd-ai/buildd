import { describe, it, expect } from 'bun:test';
import { isPlatformOperator, platformOperatorEmails, PLATFORM_OPERATOR_ENV } from './platform-operator';

const env = (v?: string) => ({ [PLATFORM_OPERATOR_ENV]: v }) as NodeJS.ProcessEnv;

describe('isPlatformOperator', () => {
  it('fails closed when the variable is unset or empty', () => {
    expect(isPlatformOperator({ email: 'a@example.com' }, env())).toBe(false);
    expect(isPlatformOperator({ email: 'a@example.com' }, env(''))).toBe(false);
    expect(isPlatformOperator({ email: 'a@example.com' }, env(' , '))).toBe(false);
  });

  it('matches a listed email, case-insensitively and ignoring spaces', () => {
    const e = env(' Ops@Example.com , second@example.com');
    expect(isPlatformOperator({ email: 'ops@example.com' }, e)).toBe(true);
    expect(isPlatformOperator({ email: 'SECOND@example.com' }, e)).toBe(true);
    expect(isPlatformOperator({ email: 'other@example.com' }, e)).toBe(false);
  });

  it('no user or no email is never an operator', () => {
    const e = env('ops@example.com');
    expect(isPlatformOperator(null, e)).toBe(false);
    expect(isPlatformOperator(undefined, e)).toBe(false);
    expect(isPlatformOperator({ email: null }, e)).toBe(false);
    expect(isPlatformOperator({ email: '' }, e)).toBe(false);
  });

  it('does not match on a substring', () => {
    expect(isPlatformOperator({ email: 'ops@example.com.evil' }, env('ops@example.com'))).toBe(false);
  });

  it('parses the list once into a normalised set', () => {
    expect([...platformOperatorEmails(env('A@x.io,b@x.io,a@x.io'))].sort()).toEqual(['a@x.io', 'b@x.io']);
  });
});
