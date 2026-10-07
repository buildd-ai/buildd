/** Task-owned CDP relay. Local services are fulfilled through container RPC, never public ingress. */
export const BROWSER_BRIDGE_HOST = "buildd-browser.invalid";
export interface BrowserSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  accept?(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}
export interface BrowserPort {
  acquire(): Promise<{ sessionId: string }>;
  connect(sessionId: string): Promise<BrowserSocket>;
  close(sessionId: string): Promise<void>;
}
export interface BrowserUsage {
  sessionMs: number;
  sessions: number;
  requests: number;
  bytes: number;
  blocked: Array<{ origin: string; count: number }>;
  served: Array<{ origin: string; count: number; bytes: number }>;
  relayErrors: number;
}
type Frame = {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: any;
  result?: any;
  error?: any;
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (code: string, status: number) => json({ code }, status);
const IDLE_MS = 10 * 60 * 1000;
const BODY_CAP = 25 * 1024 * 1024;
const BUDGET = 512 * 1024 * 1024;
export class BrowserBridge {
  private session?: {
    id: string;
    handle: string;
    started: number;
    touched: number;
  };
  private revoked = false;
  private acquiring?: Promise<Response>;
  private expiry?: ReturnType<typeof setTimeout>;
  private idle?: ReturnType<typeof setTimeout>;
  private client?: BrowserSocket;
  private upstream?: BrowserSocket;
  private ports = new Set<number>();
  private usage: BrowserUsage = {
    sessionMs: 0,
    sessions: 0,
    requests: 0,
    bytes: 0,
    blocked: [],
    served: [],
    relayErrors: 0,
  };
  private readonly now: () => number;
  constructor(
    private readonly options: {
      token: string;
      browser: BrowserPort;
      fetchService: (port: number, request: Request) => Promise<Response>;
      now?: () => number;
      /** Additional control listeners (for example a fixed runner shim port). */
      denyPorts?: number[];
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  async handle(request: Request): Promise<Response> {
    if (this.revoked) return error("session_revoked", 401);
    if (request.headers.get("authorization") !== `Bearer ${this.options.token}`)
      return error("session_unauthorized", 401);
    if (this.session && this.now() - this.session.touched > IDLE_MS)
      await this.endSession();
    const url = new URL(request.url),
      path = url.pathname;
    if (path === "/v1/session" && request.method === "POST") {
      if (this.session) return this.sessionResponse();
      if (!this.acquiring) this.acquiring = this.acquire();
      try {
        return (await this.acquiring).clone();
      } finally {
        this.acquiring = undefined;
      }
    }
    if (path === "/v1/session" && request.method === "DELETE") {
      await this.close();
      return json({ closed: true });
    }
    if (!this.session) return error("session_lost", 410);
    this.touch();
    if (path === "/v1/probe" && request.method === "GET") return this.probe();
    if (path === "/v1/evidence" && request.method === "GET")
      return json(this.evidence());
    if (path === "/v1/cdp" && request.method === "GET")
      return this.attach(request);
    const portMatch = path.match(/^\/v1\/services\/(\d+)$/);
    if (portMatch) {
      const port = Number(portMatch[1]);
      if (
        port < 1024 ||
        port > 65535 ||
        port === 8766 ||
        this.options.denyPorts?.includes(port)
      )
        return error("port_not_allowed", 400);
      if (request.method === "DELETE") {
        this.ports.delete(port);
        return json({ removed: true });
      }
      if (request.method !== "PUT") return error("method_not_allowed", 405);
      if (!this.ports.has(port) && this.ports.size >= 4)
        return error("service_limit", 409);
      let body: { readyPath?: string } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        /* empty body uses default */
      }
      const readyPath = body.readyPath ?? "/";
      if (
        !readyPath.startsWith("/") ||
        readyPath.startsWith("//") ||
        readyPath.includes("\\")
      )
        return error("port_not_allowed", 400);
      const bindUrl = `http://127.0.0.1:${port}`,
        started = this.now();
      try {
        const response = await this.options.fetchService(
          port,
          new Request(bindUrl + readyPath),
        );
        if (response.status >= 500) return error("service_unreachable", 502);
        await response.body?.cancel();
        this.ports.add(port);
        return json({
          bindUrl,
          browserUrl: bindUrl,
          reachable: true,
          status: response.status,
          latencyMs: this.now() - started,
        });
      } catch {
        return error("service_unreachable", 502);
      }
    }
    return error("not_found", 404);
  }
  private async acquire(): Promise<Response> {
    try {
      if (this.usage.sessions >= 2) return error("provider_capacity", 503);
      const { sessionId } = await this.options.browser.acquire();
      if (this.revoked) {
        await this.options.browser.close(sessionId);
        return error("session_revoked", 401);
      }
      this.session = {
        id: sessionId,
        handle: `brs_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
        started: this.now(),
        touched: this.now(),
      };
      this.usage.sessions++;
      this.touch();
      this.expiry = setTimeout(
        () => {
          void this.close().catch(() => {
            this.usage.relayErrors++;
          });
        },
        60 * 60 * 1000,
      );
      return this.sessionResponse();
    } catch {
      return error("provider_handshake_failed", 502);
    }
  }
  private sessionResponse(): Response {
    return json({
      handle: this.session!.handle,
      provider: "cloudflare",
      expiresAt: new Date(this.session!.touched + IDLE_MS).toISOString(),
    });
  }
  private async probe(): Promise<Response> {
    let socket: BrowserSocket | undefined;
    try {
      socket = await this.options.browser.connect(this.session!.id);
      const call = this.commands(socket);
      const version = await call("Browser.getVersion");
      const target = await call("Target.createTarget", { url: "about:blank" });
      await call("Target.closeTarget", { targetId: target.targetId });
      return json({
        provider: "cloudflare",
        ok: true,
        handle: this.session!.handle,
        browserVersion: version.product,
        checkedAt: new Date(this.now()).toISOString(),
      });
    } catch {
      return error("provider_handshake_failed", 502);
    } finally {
      socket?.close();
    }
  }
  private commands(socket: BrowserSocket) {
    let id = -1;
    const pending = new Map<
      number,
      {
        resolve: (result: any) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    socket.addEventListener("message", (event) => {
      let frame: Frame;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (frame.id === undefined) return;
      const waiter = pending.get(frame.id);
      if (!waiter) return;
      pending.delete(frame.id);
      clearTimeout(waiter.timer);
      if (frame.error) waiter.reject(new Error("CDP command failed"));
      else waiter.resolve(frame.result ?? {});
    });
    socket.accept?.();
    return (
      method: string,
      params: any = {},
      sessionId?: string,
    ): Promise<any> =>
      new Promise((resolve, reject) => {
        const next = id--;
        const timer = setTimeout(() => {
          pending.delete(next);
          reject(new Error("CDP timeout"));
        }, 15000);
        pending.set(next, { resolve, reject, timer });
        socket.send(
          JSON.stringify({
            id: next,
            method,
            params,
            ...(sessionId ? { sessionId } : {}),
          }),
        );
      });
  }
  private async attach(request: Request): Promise<Response> {
    if (this.client) return error("cdp_client_busy", 409);
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return error("websocket_required", 426);
    const pair = new WebSocketPair(),
      client = pair[1];
    this.client = client;
    try {
      const upstream = await this.options.browser.connect(this.session!.id);
      this.upstream = upstream;
      this.relay(client, upstream);
      client.accept();
      return new Response(null, { status: 101, webSocket: pair[0] });
    } catch {
      this.client = undefined;
      return error("provider_handshake_failed", 502);
    }
  }
  private relay(client: BrowserSocket, upstream: BrowserSocket): void {
    const call = this.commands(upstream);
    const patterns = new Map<string, any[]>(),
      paused = new Map<string, Frame>();
    const enabled = new Map<string, Promise<void>>();
    const key = (frame: Frame) =>
      `${frame.sessionId ?? ""}:${frame.params?.requestId}`;
    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      this.usage.relayErrors++;
      client.close(4001, "session_lost");
      upstream.close();
      this.client = undefined;
      void this.endSession().catch(() => {
        this.usage.relayErrors++;
      });
    };
    const reply = (frame: Frame, result = {}) =>
      client.send(
        JSON.stringify({
          id: frame.id,
          result,
          ...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
        }),
      );
    const route = async (frame: Frame, overrides: any = {}) => {
      const params = frame.params,
        req = { ...params.request, ...overrides };
      try {
        const url = new URL(req.url);
        const port = Number(url.port);
        if (
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname) &&
          this.ports.has(port)
        ) {
          const method = req.method ?? "GET";
          const headers = new Headers();
          if (Array.isArray(req.headers))
            for (const h of req.headers) headers.set(h.name, h.value);
          else
            for (const [name, value] of Object.entries(req.headers ?? {}))
              headers.set(name, String(value));
          headers.delete("authorization");
          headers.delete("proxy-authorization");
          const postData = overrides.postData
            ? atob(overrides.postData)
            : req.postData;
          const response = await this.options.fetchService(
            port,
            new Request(req.url, {
              method,
              headers,
              ...(postData && !["GET", "HEAD"].includes(method)
                ? { body: postData }
                : {}),
            }),
          );
          const parts: Uint8Array[] = [];
          let size = 0;
          const reader = response.body?.getReader();
          if (reader) {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > BODY_CAP || this.usage.bytes + size > BUDGET) {
                await reader.cancel();
                throw new Error("body_too_large");
              }
              parts.push(chunk.value);
            }
          }
          const buffer = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            buffer.set(part, offset);
            offset += part.length;
          }
          if (
            buffer.length > BODY_CAP ||
            this.usage.bytes + buffer.length > BUDGET
          )
            throw new Error("body_too_large");
          this.usage.requests++;
          this.usage.bytes += buffer.length;
          const served = this.usage.served.find((x) => x.origin === url.origin);
          if (served) {
            served.count++;
            served.bytes += buffer.length;
          } else
            this.usage.served.push({
              origin: url.origin,
              count: 1,
              bytes: buffer.length,
            });
          let binary = "";
          for (let i = 0; i < buffer.length; i += 8192)
            binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
          const responseHeaders: Array<{ name: string; value: string }> = [];
          response.headers.forEach((value, name) => {
            if (
              ![
                "content-encoding",
                "content-length",
                "transfer-encoding",
              ].includes(name)
            )
              responseHeaders.push({ name, value });
          });
          await call(
            "Fetch.fulfillRequest",
            {
              requestId: params.requestId,
              responseCode: response.status,
              responseHeaders,
              body: btoa(binary),
            },
            frame.sessionId,
          );
        } else if (["about:", "data:", "blob:"].includes(url.protocol)) {
          await call(
            "Fetch.continueRequest",
            { requestId: params.requestId },
            frame.sessionId,
          );
        } else {
          const found = this.usage.blocked.find((x) => x.origin === url.origin);
          if (found) found.count++;
          else this.usage.blocked.push({ origin: url.origin, count: 1 });
          await call(
            "Fetch.failRequest",
            { requestId: params.requestId, errorReason: "BlockedByClient" },
            frame.sessionId,
          );
        }
      } catch {
        fail();
      }
    };
    upstream.addEventListener("message", (event) => {
      void (async () => {
        this.touch();
        let frame: Frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          fail();
          return;
        }
        if (frame.id !== undefined && frame.id < 0) return;
        if (frame.method === "Target.attachedToTarget") {
          const sessionId = frame.params.sessionId;
          const ready = (async () => {
            await call(
              "Fetch.enable",
              { patterns: [{ urlPattern: "*", requestStage: "Request" }] },
              sessionId,
            );
            await call(
              "Network.setBlockedURLs",
              { urls: ["ws://*", "wss://*"] },
              sessionId,
            );
          })();
          enabled.set(sessionId, ready);
          ready.catch(fail);
        }
        if (frame.method === "Fetch.requestPaused") {
          const destination = new URL(frame.params.request.url);
          const mapped =
            destination.protocol === "http:" &&
            ["127.0.0.1", "localhost"].includes(destination.hostname) &&
            this.ports.has(Number(destination.port));
          if (
            !mapped &&
            !["data:", "blob:", "about:"].includes(destination.protocol)
          ) {
            await route(frame);
            return;
          }
          const clientPatterns = patterns.get(frame.sessionId ?? "") ?? [];
          const matches = clientPatterns.some((p) => {
            const glob = p.urlPattern ?? "*";
            const regex =
              "^" +
              glob
                .split("*")
                .map((part: string) =>
                  part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                )
                .join(".*") +
              "$";
            return (
              (!p.resourceType ||
                p.resourceType === frame.params.resourceType) &&
              new RegExp(regex).test(frame.params.request.url)
            );
          });
          if (matches) {
            paused.set(key(frame), frame);
            client.send(event.data);
          } else await route(frame);
          return;
        }
        client.send(event.data);
      })().catch(fail);
    });
    client.addEventListener("message", (event) => {
      void (async () => {
        this.touch();
        let frame: Frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          fail();
          return;
        }
        if (typeof frame.id !== "number" || frame.id < 0) {
          fail();
          return;
        }
        if (
          frame.method === "Fetch.enable" ||
          frame.method === "Fetch.disable"
        ) {
          patterns.set(
            frame.sessionId ?? "",
            frame.method === "Fetch.enable"
              ? (frame.params?.patterns ?? [{}])
              : [],
          );
          reply(frame);
          return;
        }
        if (
          ["Fetch.fulfillRequest", "Fetch.failRequest"].includes(
            frame.method ?? "",
          )
        ) {
          if (!paused.has(key(frame))) {
            fail();
            return;
          }
          paused.delete(key(frame));
          upstream.send(JSON.stringify(frame));
          return;
        }
        if (frame.method === "Fetch.continueRequest") {
          const pending = paused.get(key(frame));
          if (!pending) {
            fail();
            return;
          }
          paused.delete(key(frame));
          await route(pending, frame.params);
          reply(frame);
          return;
        }
        if (frame.method === "Browser.close") {
          reply(frame);
          client.close(1000);
          return;
        }
        if (
          [
            "Network.setBlockedURLs",
            "Network.setRequestInterception",
            "Fetch.continueResponse",
            "Target.detachFromTarget",
            "Target.sendMessageToTarget",
            "Browser.setDownloadBehavior",
            "Target.exposeDevToolsProtocol",
          ].includes(frame.method ?? "")
        ) {
          client.send(
            JSON.stringify({
              id: frame.id,
              sessionId: frame.sessionId,
              error: {
                code: -32601,
                message: "Method denied by browser bridge",
              },
            }),
          );
          return;
        }
        if (frame.method === "Target.setAutoAttach")
          frame.params = {
            ...frame.params,
            autoAttach: true,
            flatten: true,
            waitForDebuggerOnStart: true,
          };
        if (frame.method === "Target.createBrowserContext" && frame.params) {
          delete frame.params.proxyServer;
          delete frame.params.proxyBypassList;
        }
        if (frame.method === "Runtime.runIfWaitingForDebugger")
          await enabled.get(frame.sessionId ?? "");
        upstream.send(JSON.stringify(frame));
      })().catch(fail);
    });
    client.addEventListener("close", () => {
      upstream.close();
      if (this.client === client) this.client = undefined;
    });
    client.addEventListener("error", fail);
    upstream.addEventListener("error", fail);
    upstream.addEventListener("close", () => {
      if (this.client === client) {
        client.close(4001, "session_lost");
        this.client = undefined;
      }
    });
  }
  private touch(): void {
    if (!this.session) return;
    this.session.touched = this.now();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      void this.endSession().catch(() => {
        this.usage.relayErrors++;
      });
    }, IDLE_MS);
  }
  private evidence(): BrowserUsage {
    return {
      ...this.usage,
      sessionMs:
        this.usage.sessionMs +
        (this.session ? this.now() - this.session.started : 0),
      blocked: this.usage.blocked.map((x) => ({ ...x })),
      served: this.usage.served.map((x) => ({ ...x })),
    };
  }
  private async endSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = undefined;
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    this.client?.close(4001, "session_lost");
    this.upstream?.close();
    this.client = undefined;
    this.upstream = undefined;
    this.ports.clear();
    if (session) {
      this.usage.sessionMs += this.now() - session.started;
      try {
        await this.options.browser.close(session.id);
      } catch {
        this.usage.relayErrors++;
      }
    }
  }
  async close(): Promise<BrowserUsage> {
    this.revoked = true;
    await this.endSession();
    return this.evidence();
  }
}

/** Egress interception identity is authoritative; a bearer alone never chooses a task. */
export function handleScopedBrowserRequest(
  taskId: string,
  currentTaskId: string,
  bridge: BrowserBridge,
  request: Request,
): Promise<Response> {
  if (!taskId || taskId !== currentTaskId)
    return Promise.resolve(error("task_scope_mismatch", 403));
  return bridge.handle(request);
}
