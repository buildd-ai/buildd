import { describe, expect, test } from "bun:test";
import { bindingBrowserPort, type BrowserBinding } from "./browser-binding";
describe("native Browser Rendering binding adapter", () => {
  test("acquires with deny-all network guardrails and keeps ids inside binding calls", async () => {
    const calls: any[] = [];
    const socket = { send() {}, close() {}, addEventListener() {} };
    const binding = {
      async acquire(options: unknown) {
        calls.push(["acquire", options]);
        return { sessionId: "binding-private-id" };
      },
      async connectSession(id: string) {
        calls.push(["connect", id]);
        return {
          webSocket: {
            async fetch(url: string, options: unknown) {
              calls.push(["fetch", url, options]);
              return { webSocket: socket };
            },
          },
        };
      },
      async closeSession(id: string) {
        calls.push(["close", id]);
      },
    } as unknown as BrowserBinding;
    const port = bindingBrowserPort(binding);
    const session = await port.acquire();
    expect(calls[0]).toEqual([
      "acquire",
      { keepAlive: 600000, guardrails: { allowedDomains: [] } },
    ]);
    expect(await port.connect(session.sessionId)).toBe(socket);
    await port.close(session.sessionId);
    expect(calls[1]).toEqual(["connect", "binding-private-id"]);
    expect(calls[2][2]).toEqual({ headers: { Upgrade: "websocket" } });
    expect(calls[3]).toEqual(["close", "binding-private-id"]);
  });
  test("rejects a binding response that did not upgrade to CDP", async () => {
    const binding = {
      async connectSession() {
        return {
          webSocket: {
            async fetch() {
              return {};
            },
          },
        };
      },
    } as unknown as BrowserBinding;
    await expect(
      bindingBrowserPort(binding).connect("private-id"),
    ).rejects.toThrow("provider_handshake_failed");
  });
});
