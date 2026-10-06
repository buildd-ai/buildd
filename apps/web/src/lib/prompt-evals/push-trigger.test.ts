import { describe, expect, it } from 'bun:test';
import { promptEvalRefForPush } from './push-trigger';

const SHA = 'a'.repeat(40);
const env = { PROMPTS_REPO: 'Acme/acme-prompts' };
const push = (over: Record<string, unknown> = {}) => ({ ref: 'refs/heads/main', after: SHA, repository: { full_name: 'acme/acme-prompts' }, ...over });

describe('promptEvalRefForPush', () => {
  it('scores the pushed sha on the seed branch of the prompts repo', () => {
    expect(promptEvalRefForPush(push(), env)).toBe(SHA);
  });

  it('follows PROMPTS_REPO_REF', () => {
    expect(promptEvalRefForPush(push(), { ...env, PROMPTS_REPO_REF: 'release' })).toBeNull();
    expect(promptEvalRefForPush(push({ ref: 'refs/heads/release' }), { ...env, PROMPTS_REPO_REF: 'release' })).toBe(SHA);
  });

  it('ignores other repos, other branches, deletions and an unconfigured deployment', () => {
    expect(promptEvalRefForPush(push({ repository: { full_name: 'acme/app' } }), env)).toBeNull();
    expect(promptEvalRefForPush(push({ ref: 'refs/heads/wip' }), env)).toBeNull();
    expect(promptEvalRefForPush(push({ deleted: true, after: '0'.repeat(40) }), env)).toBeNull();
    expect(promptEvalRefForPush(push(), {})).toBeNull();
  });
});
