import { describe, expect, test } from "bun:test";
import { BrowserBridge, type BrowserPort } from "./browser-bridge";
function fixture(token = "run-a", clock = { time: 1000 }) {
  let acquired = 0,
    closed = 0;
  const browser: BrowserPort = {
    async acquire() {
      acquired++;
      return { sessionId: "private-session" };
    },
    async connect() {
      throw new Error("not connected in this fixture");
    },
    async close() {
      closed++;
    },
  };
  const bridge = new BrowserBridge({
    token,
    browser,
    now: () => clock.time,
    fetchService: async (_port, request) =>
      new Response(new URL(request.url).pathname),
  });
  const call = (path: string, method = "GET", bearer = token, body?: unknown) =>
    bridge.handle(
      new Request(`https://buildd-browser.invalid/v1/${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}` },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  return { bridge, call, clock, counts: () => ({ acquired, closed }) };
}
describe("task scoped browser bridge", () => {
  test("rejects another task token before acquiring a browser", async () => {
    const f = fixture();
    expect((await f.call("session", "POST", "run-b")).status).toBe(401);
    expect(f.counts().acquired).toBe(0);
  });
  test("session handles do not disclose provider ids and acquisition is idempotent", async () => {
    const f = fixture();
    const a = await (await f.call("session", "POST")).json();
    const b = await (await f.call("session", "POST")).json();
    expect(a.handle).toMatch(/^brs_/);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toContain("private-session");
    expect(f.counts().acquired).toBe(1);
  });
  test("only allowed ready services are registered and mappings remain task-local", async () => {
    const a = fixture(),
      b = fixture("run-b");
    await a.call("session", "POST");
    await b.call("session", "POST");
    expect((await a.call("services/80", "PUT")).status).toBe(400);
    expect(
      (await a.call("services/4123", "PUT", "run-a", { readyPath: "/ready" }))
        .status,
    ).toBe(200);
    expect((await b.call("services/4123", "PUT", "run-a")).status).toBe(401);
    expect(
      (
        await a.call("services/4124", "PUT", "run-a", {
          readyPath: "//evil.test/",
        })
      ).status,
    ).toBe(400);
  });
  test("close revokes the token and counts browser session time once", async () => {
    const f = fixture();
    await f.call("session", "POST");
    f.clock.time += 2500;
    const usage = await f.bridge.close();
    expect(usage.sessionMs).toBe(2500);
    expect((await f.call("session", "POST")).status).toBe(401);
    await f.bridge.close();
    expect(f.counts().closed).toBe(1);
  });
  test("idle sessions expire without allowing stale capabilities", async () => {
    const f = fixture();
    await f.call("session", "POST");
    f.clock.time += 600001;
    expect((await f.call("probe")).status).toBe(410);
    expect(f.counts().closed).toBe(1);
  });
});

class Socket {
  frames: any[] = [];
  listeners = new Map<string, Array<(event: any) => void>>();
  closed = false;
  autoReply = false;
  addEventListener(type: string, listener: (event: any) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  send(data: string) {
    const frame = JSON.parse(data);
    this.frames.push(frame);
    if (this.autoReply && frame.id < 0)
      queueMicrotask(() => this.emit({ id: frame.id, result: {} }));
  }
  emit(frame: any) {
    for (const listener of this.listeners.get("message") ?? [])
      listener({ data: JSON.stringify(frame) });
  }
  close() {
    this.closed = true;
  }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
describe("CDP private-service mediation", () => {
  test("client routes see mapped requests before container fetch and continued requests are fulfilled", async () => {
    let served = 0;
    const bridge = new BrowserBridge({
      token: "own",
      browser: {
        async acquire() {
          return { sessionId: "hidden" };
        },
        async connect() {
          return new Socket();
        },
        async close() {},
      },
      fetchService: async () => {
        served++;
        return new Response("own service");
      },
    });
    const request = (path: string, method: string) =>
      new Request(`https://buildd-browser.invalid/v1/${path}`, {
        method,
        headers: { authorization: "Bearer own" },
      });
    await bridge.handle(request("session", "POST"));
    await bridge.handle(request("services/4123", "PUT"));
    const client = new Socket(),
      remote = new Socket();
    remote.autoReply = true;
    (bridge as any).relay(client, remote);
    client.emit({
      id: 1,
      sessionId: "page",
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: "*" }] },
    });
    remote.emit({
      sessionId: "page",
      method: "Fetch.requestPaused",
      params: {
        requestId: "r1",
        request: { url: "http://127.0.0.1:4123/x", method: "GET" },
      },
    });
    await flush();
    expect(served).toBe(1);
    expect(client.frames.some((f) => f.method === "Fetch.requestPaused")).toBe(
      true,
    );
    client.emit({
      id: 2,
      sessionId: "page",
      method: "Fetch.continueRequest",
      params: { requestId: "r1" },
    });
    await flush();
    expect(served).toBe(2);
    expect(
      remote.frames.find((f) => f.method === "Fetch.fulfillRequest")?.params
        .body,
    ).toBe(btoa("own service"));
    const usage = await (
      await bridge.handle(request("evidence", "GET"))
    ).json();
    expect(usage.requests).toBe(1);
  });
  test("unregistered loopback and public destinations never reach container or browser network", async () => {
    const f = fixture();
    await f.call("session", "POST");
    const client = new Socket(),
      remote = new Socket();
    remote.autoReply = true;
    (f.bridge as any).relay(client, remote);
    client.emit({
      id: 1,
      method: "Fetch.enable",
      params: { patterns: [{ urlPattern: "*" }] },
    });
    for (const url of ["http://127.0.0.1:4124/", "https://example.com/"])
      remote.emit({
        method: "Fetch.requestPaused",
        params: { requestId: url, request: { url, method: "GET" } },
      });
    await flush();
    expect(
      remote.frames.filter((f) => f.method === "Fetch.failRequest"),
    ).toHaveLength(2);
    expect(
      remote.frames.some((f) => f.method === "Fetch.continueRequest"),
    ).toBe(false);
    expect(client.frames.some((f) => f.method === "Fetch.requestPaused")).toBe(
      false,
    );
    const usage = await (await f.call("evidence")).json();
    expect(usage.blocked).toHaveLength(2);
  });
  test("holds debugger release until Fetch mediation is acknowledged", async () => {
    const f = fixture();
    await f.call("session", "POST");
    const client = new Socket(),
      remote = new Socket();
    (f.bridge as any).relay(client, remote);
    remote.emit({
      method: "Target.attachedToTarget",
      params: { sessionId: "page" },
    });
    client.emit({
      id: 10,
      sessionId: "page",
      method: "Runtime.runIfWaitingForDebugger",
    });
    await flush();
    expect(remote.frames.some((f) => f.id === 10)).toBe(false);
    const enable = remote.frames.find((f) => f.method === "Fetch.enable");
    remote.emit({ id: enable.id, result: {} });
    await flush();
    const blocked = remote.frames.find(
      (f) => f.method === "Network.setBlockedURLs",
    );
    remote.emit({ id: blocked.id, result: {} });
    await flush();
    expect(remote.frames.some((f) => f.id === 10)).toBe(true);
  });
});

describe("interception identity and control-port isolation", () => {
  test("correct bearer cannot cross the interception task identity", async () => {
    const { handleScopedBrowserRequest } = await import("./browser-bridge");
    const f = fixture();
    const request = new Request("https://buildd-browser.invalid/v1/session", {
      method: "POST",
      headers: { authorization: "Bearer run-a" },
    });
    expect(
      (await handleScopedBrowserRequest("task-b", "task-a", f.bridge, request))
        .status,
    ).toBe(403);
    expect(f.counts().acquired).toBe(0);
    expect(
      (await handleScopedBrowserRequest("task-a", "task-a", f.bridge, request))
        .status,
    ).toBe(200);
  });
  test("runner control port cannot be exposed as a reviewed service", async () => {
    const f = fixture();
    await f.call("session", "POST");
    expect((await f.call("services/8766", "PUT")).status).toBe(400);
  });
});

test("run cleanup remains revoked and reportable when provider close fails", async () => {
  const bridge = new BrowserBridge({
    token: "own",
    browser: {
      async acquire() {
        return { sessionId: "hidden" };
      },
      async connect() {
        return new Socket();
      },
      async close() {
        throw new Error("provider offline");
      },
    },
    fetchService: async () => new Response("ready"),
  });
  const req = () =>
    new Request("https://buildd-browser.invalid/v1/session", {
      method: "POST",
      headers: { authorization: "Bearer own" },
    });
  await bridge.handle(req());
  const usage = await bridge.close();
  expect(usage.relayErrors).toBe(1);
  expect((await bridge.handle(req())).status).toBe(401);
});

test('a second CDP client is refused before connecting a browser socket', async () => {
  const f = fixture();
  await f.call('session', 'POST');
  (f.bridge as any).client = new Socket();
  const response = await f.bridge.handle(new Request('https://buildd-browser.invalid/v1/cdp', {
    headers: { authorization: 'Bearer run-a', Upgrade: 'websocket' },
  }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: 'cdp_client_busy' });
  await f.bridge.close();
});
