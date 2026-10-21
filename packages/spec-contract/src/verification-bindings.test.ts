import { describe, expect, it } from 'bun:test';
import { criterionRecords } from './criterion-records';
import {
  bindingFingerprint,
  bindingLine,
  criterionBindings,
  verificationCoverage,
  type VerificationBinding,
  type VerifierRegistry,
} from './verification-bindings';

/**
 * Acceptance tests for "Registered requirement verification in Build, Verify
 * and Deliver" (revision 1): registered bindings declared in the approved
 * spec body. Written before the build; the module under test does not exist
 * on the mission's starting commit.
 *
 * Contract these tests pin:
 *  - A binding is one `verify:` line under its criterion, read by the same
 *    rule as `check:` lines (nearest R-n / AC-n above it; fenced blocks
 *    skipped). Its value is `key=value` pairs, not a language:
 *      verify: verifier=<id>@<version> profile=<id>@<version> mode=<required|advisory> evidence=<a>,<b>
 *  - `criterionBindings(body, registry)` returns the bindings it accepts and,
 *    separately, every one it refuses with a reason. Nothing is dropped.
 *  - `bindingLine(b)` writes the line `criterionBindings` reads back.
 *  - `bindingFingerprint(b)` is a stable hash of the complete identity.
 *  - `verificationCoverage(body, registry)` says, per criterion, how it is
 *    covered: `command`, `registered`, `unsupported` or `none`.
 */

const REGISTRY: VerifierRegistry = {
  verifiers: [
    { id: 'ui.action-state', version: 1, method: 'deterministic', evidence: ['ui.text', 'ui.actions', 'ui.state'] },
    { id: 'ui.copy', version: 1, method: 'model', evidence: ['ui.text', 'ui.actions'] },
    { id: 'ui.copy', version: 2, method: 'model', evidence: ['ui.text', 'ui.actions'] },
  ],
  profiles: [{ id: 'buildd-ui', version: 1 }, { id: 'buildd-ui', version: 2 }],
};

const PROSE = 'The task card offers one action that matches the PR state.';
const LINE_V1 = 'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state';

const body = (...lines: string[]) => ['## Acceptance', '', `AC-1 ${PROSE}`, ...lines.map((l) => `  ${l}`), '', 'AC-2 Another check.', ''].join('\n');

const BINDING: VerificationBinding = {
  criterionId: 'AC-1',
  verifier: { id: 'ui.action-state', version: 1 },
  profile: { id: 'buildd-ui', version: 1 },
  mode: 'required',
  evidence: ['ui.text', 'ui.actions', 'ui.state'],
};

describe('registered verification bindings', () => {
  it('AC-1: approved-body bindings round-trip, refuse unsupported identities and move the fingerprint, not the prose', () => {
    // Round trip: the line written for a binding reads back as that binding.
    const written = bindingLine(BINDING);
    const parsed = criterionBindings(body(written), REGISTRY);
    expect(parsed.refused).toEqual([]);
    expect(parsed.bindings).toEqual([BINDING]);
    expect(criterionBindings(body(LINE_V1), REGISTRY).bindings).toEqual([BINDING]);

    // Unsupported identities are refused with a reason, never dropped silently.
    const unknownVerifier = criterionBindings(body('verify: verifier=ui.nope@1 profile=buildd-ui@1 mode=required evidence=ui.text'), REGISTRY);
    expect(unknownVerifier.bindings).toEqual([]);
    expect(unknownVerifier.refused).toEqual([expect.objectContaining({ criterionId: 'AC-1', reason: 'unknown_verifier' })]);
    const unknownVersion = criterionBindings(body('verify: verifier=ui.action-state@9 profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state'), REGISTRY);
    expect(unknownVersion.refused).toEqual([expect.objectContaining({ criterionId: 'AC-1', reason: 'unknown_verifier' })]);
    const unknownProfile = criterionBindings(body('verify: verifier=ui.action-state@1 profile=acme@1 mode=required evidence=ui.text,ui.actions,ui.state'), REGISTRY);
    expect(unknownProfile.refused).toEqual([expect.objectContaining({ criterionId: 'AC-1', reason: 'unknown_profile' })]);

    // A changed binding changes the fingerprint; the criterion's prose does not change.
    const v2Line = 'verify: verifier=ui.action-state@1 profile=buildd-ui@2 mode=required evidence=ui.text,ui.actions,ui.state';
    const a = criterionBindings(body(LINE_V1), REGISTRY).bindings[0]!;
    const b = criterionBindings(body(v2Line), REGISTRY).bindings[0]!;
    expect(bindingFingerprint(a)).toBe(bindingFingerprint(BINDING));
    expect(bindingFingerprint(a)).not.toBe(bindingFingerprint(b));
    expect(bindingFingerprint({ ...BINDING, mode: 'advisory' })).not.toBe(bindingFingerprint(BINDING));
    expect(bindingFingerprint({ ...BINDING, evidence: ['ui.text', 'ui.actions'] })).not.toBe(bindingFingerprint(BINDING));
    const prose = (text: string) => criterionRecords(text).find((r) => r.id === 'AC-1')!.text;
    expect(prose(body(LINE_V1))).toBe(PROSE);
    expect(prose(body(v2Line))).toBe(PROSE);
    expect(prose(body())).toBe(PROSE);
  });

  it('R-1: coverage is explicit per criterion; a criterion with nothing declared reads none, never a pass', () => {
    const text = [
      '## Acceptance', '',
      'AC-1 Has a command.', '  check: bun run scripts/run-unit-tests.ts a.test.ts', '',
      `AC-2 Has a registered verifier.`, `  ${LINE_V1}`, '',
      'AC-3 Has an unknown verifier.', '  verify: verifier=ui.nope@1 profile=buildd-ui@1 mode=required evidence=ui.text', '',
      'AC-4 Has nothing.', '',
    ].join('\n');
    const coverage = Object.fromEntries(verificationCoverage(text, REGISTRY).map((c) => [c.criterionId, c.coverage]));
    expect(coverage).toEqual({ 'AC-1': 'command', 'AC-2': 'registered', 'AC-3': 'unsupported', 'AC-4': 'none' });
    for (const c of verificationCoverage(text, REGISTRY)) expect(c.coverage).not.toBe('pass');
  });

  it('R-2: a binding names criterion, verifier/version, profile/version, mode and evidence; anything less is refused as malformed', () => {
    for (const line of [
      'verify: profile=buildd-ui@1 mode=required evidence=ui.text',
      'verify: verifier=ui.action-state profile=buildd-ui@1 mode=required evidence=ui.text,ui.actions,ui.state',
      'verify: verifier=ui.action-state@1 mode=required evidence=ui.text,ui.actions,ui.state',
      'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=sometimes evidence=ui.text,ui.actions,ui.state',
      'verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required',
      'verify: run(rm -rf /)',
    ]) {
      const r = criterionBindings(body(line), REGISTRY);
      expect(r.bindings).toEqual([]);
      expect(r.refused).toEqual([expect.objectContaining({ criterionId: 'AC-1', reason: 'malformed' })]);
    }
    // A binding inside a fenced example is not a declaration.
    expect(criterionBindings(body('```', LINE_V1, '```'), REGISTRY)).toEqual({ bindings: [], refused: [] });
  });

  it('R-3: incompatible evidence is refused, and an ordinary check command stays compatible beside a binding', () => {
    const short = criterionBindings(body('verify: verifier=ui.action-state@1 profile=buildd-ui@1 mode=required evidence=ui.text'), REGISTRY);
    expect(short.bindings).toEqual([]);
    expect(short.refused).toEqual([expect.objectContaining({ criterionId: 'AC-1', reason: 'incompatible_evidence' })]);
    const both = body('check: bun run scripts/run-unit-tests.ts a.test.ts', LINE_V1);
    expect(criterionRecords(both).find((r) => r.id === 'AC-1')!.checks).toEqual(['bun run scripts/run-unit-tests.ts a.test.ts']);
    expect(criterionBindings(both, REGISTRY).bindings).toEqual([BINDING]);
  });

  it('R-20: the profile is part of the contract identity, not a flag; an unregistered profile is not silently given Buildd\'s', () => {
    const acme = criterionBindings(body('verify: verifier=ui.copy@1 profile=acme-ui@1 mode=advisory evidence=ui.text,ui.actions'), REGISTRY);
    expect(acme.bindings).toEqual([]);
    expect(acme.refused).toEqual([expect.objectContaining({ reason: 'unknown_profile' })]);
    const withAcme: VerifierRegistry = { ...REGISTRY, profiles: [...REGISTRY.profiles, { id: 'acme-ui', version: 1 }] };
    const ok = criterionBindings(body('verify: verifier=ui.copy@1 profile=acme-ui@1 mode=advisory evidence=ui.text,ui.actions'), withAcme);
    expect(ok.bindings[0]?.profile).toEqual({ id: 'acme-ui', version: 1 });
    expect(ok.bindings[0]?.verifier).toEqual({ id: 'ui.copy', version: 1 });
  });
});
