/**
 * Default role bodies resolve through the versioned prompts table: an active
 * row changes the text seeded, resynced and delivered at claim time, and an
 * unedited seeded row follows the resolved text as it changes (a row going
 * active, a new version, its removal), with no code change or version bump.
 */
import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';

let updates: Array<{ set: Record<string, unknown> }> = [];

mock.module('@buildd/core/db', () => ({
  db: {
    // The policy-override record read: no record.
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => { updates.push({ set }); },
      }),
    }),
    insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
  },
}));

const defaultRoles = await import('./default-roles');
const {
  DEFAULT_ROLES, ROLE_PROMPT_IDS, deliverSeededRoleContent, planDefaultRoleResync, resolveDefaultRoles, roleContentHash, rolePromptId,
} = defaultRoles;
const { activePromptFingerprints, installPrompts, listRegisteredPrompts, promptFallbackCounts, resetPrompts } = await import('@buildd/core/prompts');
const { promptContentHash } = await import('@buildd/core/prompts-source');
const { resetPolicyOverrides } = await import('./policy-overrides');
const { resetPolicyOverridesLoader } = await import('./policy-overrides-source');

const builder = DEFAULT_ROLES.find(r => r.slug === 'builder')!;
const prompt = (body: string, version = 1) => ({ id: rolePromptId('builder'), version, body, contentHash: promptContentHash(body) });
const seeded = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', slug: 'builder', source: 'system', content: builder.content,
  contentHash: roleContentHash(builder.content), metadata: { defaultRoleVersion: builder.version }, ...over,
});
const flush = () => new Promise(r => setTimeout(r, 0));

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  updates = [];
  resetPrompts();
  resetPolicyOverrides();
  resetPolicyOverridesLoader();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  resetPrompts();
  warn.mockRestore();
});

describe('default roles through the prompts table', () => {
  it('names one prompt id per default role', () => {
    expect(ROLE_PROMPT_IDS).toHaveLength(DEFAULT_ROLES.length);
    expect(ROLE_PROMPT_IDS).toContain('buildd.role.builder');
  });

  it('with no row, the resolved roles are the public text', () => {
    expect(resolveDefaultRoles().map(r => r.content)).toEqual(DEFAULT_ROLES.map(r => r.content));
  });

  it('an active row replaces the body, on top of a policy override', () => {
    installPrompts([prompt('# Builder (private)')]);
    const roles = resolveDefaultRoles({ builder: { content: 'override text', description: 'override description' } });
    const b = roles.find(r => r.slug === 'builder')!;
    expect(b.content).toBe('# Builder (private)');
    expect(b.description).toBe('override description');
    expect(b.fromPrompt).toBe(true);
    expect(roles.find(r => r.slug === 'organizer')!.content).toBe(DEFAULT_ROLES.find(r => r.slug === 'organizer')!.content);
  });

  it('an active row changes the role text delivered at claim, and moves the unedited row to it', async () => {
    installPrompts([prompt('# Builder (private)')]);
    expect(await deliverSeededRoleContent(seeded())).toBe('# Builder (private)');
    await flush();
    expect(updates).toHaveLength(1);
    expect(updates[0].set.content).toBe('# Builder (private)');
    expect(updates[0].set.contentHash).toBe(roleContentHash('# Builder (private)'));
    expect((updates[0].set.metadata as Record<string, unknown>).defaultRolePromptHash).toBe(roleContentHash('# Builder (private)'));
  });

  it('a row a team edited keeps its edit and is delivered as stored', async () => {
    installPrompts([prompt('# Builder (private)')]);
    const edited = seeded({ content: '# Our builder', contentHash: roleContentHash('# Our builder') });
    expect(await deliverSeededRoleContent(edited)).toBe('# Our builder');
    expect(await deliverSeededRoleContent(seeded({ source: 'user' }))).toBe(builder.content);
    await flush();
    expect(updates).toEqual([]);
  });

  it('a new row version reaches a row holding the previous one; removing the row reverts it', () => {
    const v1 = '# Builder v1 (private)';
    const v1Row = seeded({ content: v1, contentHash: roleContentHash(v1), metadata: { defaultRoleVersion: builder.version, defaultRolePromptHash: roleContentHash(v1) } });

    installPrompts([prompt('# Builder v2 (private)', 2)]);
    const [toV2] = planDefaultRoleResync([v1Row], resolveDefaultRoles());
    expect(toV2.content).toBe('# Builder v2 (private)');

    resetPrompts();
    const [back] = planDefaultRoleResync([v1Row], resolveDefaultRoles());
    expect(back.content).toBe(builder.content);

    // An edit made after the platform wrote v1 leaves the stamp behind: untouched.
    installPrompts([prompt('# Builder v2 (private)', 2)]);
    const editedAfter = { ...v1Row, contentHash: roleContentHash('# edited') };
    expect(planDefaultRoleResync([editedAfter], resolveDefaultRoles())).toEqual([]);
  });

  it('without a prompts row, a code or override change still needs a version bump (unchanged behaviour)', () => {
    const roles = resolveDefaultRoles({ builder: { content: 'override text' } });
    expect(planDefaultRoleResync([seeded()], roles)).toEqual([]);
  });
});

describe('Platform Operator persona', () => {
  const { OPERATOR_PROMPT_ID, resolveRolePersona, rolePersonaIdentity } = defaultRoles;
  const operator = DEFAULT_ROLES.find(r => r.slug === 'operator')!;
  const row = (body: string, version: number) => ({ id: OPERATOR_PROMPT_ID, version, body, contentHash: promptContentHash(body) });

  it('is a registered default role with its own prompt id', () => {
    expect(OPERATOR_PROMPT_ID).toBe('buildd.role.operator');
    expect(ROLE_PROMPT_IDS).toContain(OPERATOR_PROMPT_ID);
    expect(listRegisteredPrompts().map(p => p.id)).toContain(OPERATOR_PROMPT_ID);
  });

  it('with no prompts row, resolves to the public fallback and counts the fallback', () => {
    const p = resolveRolePersona('operator')!;
    expect(p).toEqual({
      slug: 'operator', promptId: OPERATOR_PROMPT_ID, source: 'default',
      promptVersion: `v${operator.version}`, fingerprint: roleContentHash(operator.content), body: operator.content,
    });
    expect(promptFallbackCounts()[OPERATOR_PROMPT_ID]).toEqual({ missing: 1, invalid: 0 });
    // Only the one id was resolved: no other role's fallback was counted.
    expect(Object.keys(promptFallbackCounts())).toEqual([OPERATOR_PROMPT_ID]);
  });

  it('an active row supplies the body; version and fingerprint name that row', () => {
    installPrompts([row('# Operator (stand-in private text)', 3)]);
    const p = resolveRolePersona('operator')!;
    expect(p.source).toBe('active');
    expect(p.body).toBe('# Operator (stand-in private text)');
    expect(p.promptVersion).toBe(`v${operator.version}+p3`);
    expect(p.fingerprint).toBe(promptContentHash('# Operator (stand-in private text)'));
    // The fingerprint is the one deploy identity reports for that row.
    expect(activePromptFingerprints()).toContainEqual({ id: OPERATOR_PROMPT_ID, version: 3, contentHash: p.fingerprint });
  });

  it('a new row version changes version and fingerprint; removing it reverts to the fallback', () => {
    installPrompts([row('# Operator v1', 1)]);
    const v1 = resolveRolePersona('operator')!;
    installPrompts([row('# Operator v2', 2)]);
    const v2 = resolveRolePersona('operator')!;
    expect(v2.promptVersion).not.toBe(v1.promptVersion);
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
    resetPrompts();
    expect(resolveRolePersona('operator')!.fingerprint).toBe(roleContentHash(operator.content));
  });

  it('a blank row is rejected and the fallback runs', () => {
    installPrompts([row('   ', 4)]);
    const p = resolveRolePersona('operator')!;
    expect(p.source).toBe('default');
    expect(p.body).toBe(operator.content);
    expect(promptFallbackCounts()[OPERATOR_PROMPT_ID]).toEqual({ missing: 0, invalid: 1 });
  });

  it('the identity carries no prompt text', () => {
    installPrompts([row('# Operator (stand-in private text)', 3)]);
    const identity = rolePersonaIdentity(resolveRolePersona('operator')!);
    expect(Object.keys(identity).sort()).toEqual(['fingerprint', 'promptId', 'promptVersion', 'slug', 'source']);
    expect(JSON.stringify(identity)).not.toContain('stand-in private text');
  });

  it('is null for a slug with no default role', () => {
    expect(resolveRolePersona('not-a-role')).toBeNull();
  });

  it('the public fallback does not route and grants nothing by itself', () => {
    expect(operator.routing).toEqual({ disabled: true });
    expect(operator.canDelegateTo).toEqual([]);
  });
});
