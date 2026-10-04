/**
 * GitHub throttling telemetry: what the egress handler records when GitHub
 * answers 429 (or a rate-limited 403), so the run report can tell the
 * installation's primary limit from a secondary limit from git-only
 * throttling. Numbers and fixed labels only: no URL, no token, no body.
 */
import { describe, expect, test } from 'bun:test';
import {
  applyEgressDetail,
  assembleRunReport,
  emptyEgressDetail,
  githubRateLimitEvent,
  inspectGithubThrottle,
  isEgressEvent,
  retryAfterBucket,
  throttleLogLine,
  type RunReportInput,
} from './run-report';

const h = (o: Record<string, string>) => new Headers(o);

describe('githubRateLimitEvent', () => {
  test('a 429 with every signal', () => {
    const ev = githubRateLimitEvent({
      status: 429,
      host: 'github.com',
      headers: h({ 'retry-after': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'core' }),
      bodyPrefix: 'You have exceeded a secondary rate limit.',
    });
    expect(ev).toEqual({ type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: 60, remaining: 0, resource: 'core', secondary: true });
  });

  test('a bare 429 still counts, with no signals', () => {
    expect(githubRateLimitEvent({ status: 429, host: 'github.com', headers: h({}), bodyPrefix: '' })).toEqual({
      type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: null, remaining: null, resource: 'none', secondary: false,
    });
  });

  test('a 403 counts only when it is a rate limit', () => {
    expect(githubRateLimitEvent({ status: 403, host: 'api.github.com', headers: h({ 'x-ratelimit-remaining': '12' }), bodyPrefix: 'Resource not accessible by integration' })).toBeNull();
    expect(githubRateLimitEvent({ status: 403, host: 'api.github.com', headers: h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-resource': 'graphql' }), bodyPrefix: '' })?.resource).toBe('graphql');
    expect(githubRateLimitEvent({ status: 403, host: 'api.github.com', headers: h({ 'retry-after': '30' }), bodyPrefix: '' })?.retryAfterS).toBe(30);
    expect(githubRateLimitEvent({ status: 403, host: 'api.github.com', headers: h({}), bodyPrefix: '{"message":"You have exceeded a secondary rate limit"}' })?.secondary).toBe(true);
  });

  test('other statuses are not throttling', () => {
    for (const status of [200, 401, 404, 500]) {
      expect(githubRateLimitEvent({ status, host: 'github.com', headers: h({ 'retry-after': '5' }), bodyPrefix: 'rate limit' })).toBeNull();
    }
  });

  test('values are bounded: an unknown resource and host are fixed labels, junk numbers are dropped, a date Retry-After becomes seconds', () => {
    const ev = githubRateLimitEvent({
      status: 429,
      host: 'evil.example' as never,
      headers: h({ 'retry-after': new Date(Date.now() + 90_000).toUTCString(), 'x-ratelimit-remaining': '-3', 'x-ratelimit-resource': '/repos/acme/secret' }),
      bodyPrefix: '',
    })!;
    expect(ev.host).toBe('other');
    expect(ev.resource).toBe('other');
    expect(ev.remaining).toBeNull();
    expect(ev.retryAfterS).toBeGreaterThanOrEqual(85);
    expect(ev.retryAfterS).toBeLessThanOrEqual(90);
  });

  test('retryAfterBucket', () => {
    expect(retryAfterBucket(null)).toBe('none');
    expect(retryAfterBucket(0)).toBe('0');
    expect(retryAfterBucket(10)).toBe('1-10');
    expect(retryAfterBucket(60)).toBe('11-60');
    expect(retryAfterBucket(300)).toBe('61-300');
    expect(retryAfterBucket(3600)).toBe('301+');
  });
});

describe('inspectGithubThrottle', () => {
  test('reads only a bounded prefix of the body and leaves the original response readable', async () => {
    const big = `You have exceeded a secondary rate limit. ${'x'.repeat(100_000)}`;
    const res = new Response(big, { status: 403, headers: { 'retry-after': '120' } });
    const ev = await inspectGithubThrottle(res.clone(), 'github.com');
    expect(ev).toMatchObject({ status: 403, secondary: true, retryAfterS: 120 });
    expect((await res.text()).length).toBe(big.length);
  });

  test('the secondary-limit text past the first 512 bytes is not looked at', async () => {
    const res = new Response(`${'x'.repeat(600)} secondary rate limit`, { status: 429 });
    expect((await inspectGithubThrottle(res, 'github.com'))?.secondary).toBe(false);
  });

  test('a non-throttling status reads nothing', async () => {
    const res = new Response('ok', { status: 200 });
    expect(await inspectGithubThrottle(res, 'github.com')).toBeNull();
    expect(res.bodyUsed).toBe(false);
  });
});

describe('the run report', () => {
  test('a rate_limit event is a valid egress event; a malformed one is not', () => {
    expect(isEgressEvent({ type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: null, remaining: null, resource: 'none', secondary: false })).toBe(true);
    expect(isEgressEvent({ type: 'rate_limit', cls: 'model', status: 429, host: 'github.com', retryAfterS: null, remaining: null, resource: 'none', secondary: false })).toBe(false);
    expect(isEgressEvent({ type: 'rate_limit', cls: 'github', status: 'x' })).toBe(false);
  });

  test('throttled responses aggregate into egressDetail.github.rateLimit: counts, max Retry-After, min remaining', () => {
    const d = emptyEgressDetail();
    expect(d.github.rateLimit).toBeUndefined();
    const ev = (o: Record<string, unknown>) => ({ type: 'rate_limit' as const, cls: 'github' as const, status: 429, host: 'github.com' as const, retryAfterS: null, remaining: null, resource: 'none' as const, secondary: false, ...o });
    applyEgressDetail(d, ev({ retryAfterS: 60, remaining: 0, resource: 'core' }));
    applyEgressDetail(d, ev({ retryAfterS: 5, secondary: true }));
    applyEgressDetail(d, ev({ status: 403, host: 'api.github.com', remaining: 3, resource: 'core' }));
    expect(d.github.rateLimit).toEqual({
      throttled: 3,
      statuses: { '429': 2, '403': 1 },
      hosts: { 'github.com': 2, 'api.github.com': 1 },
      retryAfter: { '11-60': 1, '1-10': 1, none: 1 },
      retryAfterMax: 60,
      remainingMin: 0,
      resources: { core: 2, none: 1 },
      secondary: 1,
    });
  });

  test('the report carries rateLimit, normalized; absent when nothing was throttled', () => {
    const base: RunReportInput = { taskId: 'task-1', attempt: 1, dispatchReceivedAt: 1_000, timings: { exitedAt: 2_000 }, exitCode: 0, outcome: 'done', crashReport: null };
    expect(assembleRunReport(base).egressDetail.github.rateLimit).toBeUndefined();
    const d = emptyEgressDetail();
    applyEgressDetail(d, { type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: 30, remaining: null, resource: 'none', secondary: false });
    const tampered = JSON.parse(JSON.stringify(d));
    tampered.github.rateLimit.resources['/repos/acme/secret'] = 4;
    tampered.github.rateLimit.hosts['evil.example'] = 1;
    tampered.github.rateLimit.retryAfterMax = 'Bearer ghs_x';
    const r = assembleRunReport({ ...base, egressDetail: tampered });
    expect(r.egressDetail.github.rateLimit).toEqual({
      throttled: 1, statuses: { '429': 1 }, hosts: { 'github.com': 1 }, retryAfter: { '11-60': 1 },
      retryAfterMax: null, remainingMin: null, resources: { none: 1 }, secondary: 0,
    });
  });

  test('the log line has the numbers and the task, and nothing else', () => {
    const line = throttleLogLine('task-1', { type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: 60, remaining: 0, resource: 'core', secondary: true });
    expect(line).toBe('[cloud-runner] task task-1: GitHub throttled 429 host=github.com retry-after=60 remaining=0 resource=core secondary=true');
    expect(throttleLogLine('task-1', { type: 'rate_limit', cls: 'github', status: 429, host: 'github.com', retryAfterS: null, remaining: null, resource: 'none', secondary: false }))
      .toBe('[cloud-runner] task task-1: GitHub throttled 429 host=github.com retry-after=none remaining=none resource=none secondary=false');
  });
});
