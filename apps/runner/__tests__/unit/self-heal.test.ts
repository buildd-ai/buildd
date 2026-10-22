import { expect, test } from 'bun:test';
import { createPeriodicSelfHeal, SELF_HEAL_INTERVAL_MS } from '../../src/self-heal';
import { fileURLToPath } from 'url';

const fixture = fileURLToPath(new URL('../fixtures/self-heal-child.ts', import.meta.url));
function setup(mode: string, timeoutMs = 5000) {
  let now = 0;
  const logs: string[] = [];
  const errors: string[] = [];
  const output: string[] = [];
  const tick = createPeriodicSelfHeal({
    executable: process.execPath, args: [fixture, mode], timeoutMs,
    onStdout: chunk => output.push(chunk),
    now: () => now, log: line => logs.push(line), error: line => errors.push(line),
  });
  return { tick, logs, errors, output, advance: (ms: number) => { now += ms; } };
}

for (const mode of ['fix', 'diagnostic']) {
  test(`logs fixes on ${mode} exit`, async () => {
    const s = setup(mode);
    s.advance(SELF_HEAL_INTERVAL_MS);
    await s.tick();
    expect(s.logs).toEqual(['[self-heal] ✓ fixture repaired']);
    expect(s.errors).toEqual([]);
  });
}

test('no fix output stays quiet; timer calls are gated for thirty minutes', async () => {
  const s = setup('none');
  await s.tick();
  s.advance(SELF_HEAL_INTERVAL_MS - 1);
  await s.tick();
  expect(s.logs).toEqual([]);
  expect(s.output).toEqual([]);
  s.advance(1);
  await s.tick();
  expect(s.output.join('')).toBe('Diagnostic report\n');
  await s.tick();
  s.advance(SELF_HEAL_INTERVAL_MS - 1);
  await s.tick();
  expect(s.output.join('')).toBe('Diagnostic report\n');
  s.advance(1);
  await s.tick();
  expect(s.output.join('')).toBe('Diagnostic report\nDiagnostic report\n');
  expect(s.errors).toEqual([]);
  expect(s.logs).toEqual([]);
});

for (const [mode, detail] of [['timeout', 'repair stalled'], ['crash', 'repair crashed'], ['signal', 'repair interrupted']]) {
  // Windows has no signals: a self-SIGTERM exits with plain code 1, which is the doctor's "findings" exit.
  test.skipIf(mode === 'signal' && process.platform === 'win32')(`partial stdout does not hide ${mode}`, async () => {
    const s = setup(mode, mode === 'timeout' ? 500 : 5000);
    s.advance(SELF_HEAL_INTERVAL_MS);
    await s.tick();
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toContain('Doctor check failed:');
    expect(s.errors[0]).toContain(detail);
    expect(s.logs).toEqual([]);
  });
}

test('blocking doctor child leaves parent /health responsive within one second', async () => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  let now = 0;
  let launches = 0;
  const tick = createPeriodicSelfHeal({
    executable: process.execPath, args: [fixture, 'block'], now: () => now,
    onStdout: chunk => { if (chunk.includes('BLOCKING')) { launches++; started(); } },
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('healthy') });
  let pending: Promise<void> | undefined;
  try {
    await tick();
    now = SELF_HEAL_INTERVAL_MS;
    pending = tick();
    await ready;
    await tick();
    now++;
    await tick();
    const before = performance.now();
    const response = await fetch(new URL('/health', server.url), { signal: AbortSignal.timeout(1000) });
    expect(await response.text()).toBe('healthy');
    expect(performance.now() - before).toBeLessThan(1000);
    await pending;
    await tick();
    expect(launches).toBe(1);
  } finally {
    await pending;
    server.stop(true);
  }
}, 10000);
