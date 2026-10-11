import type { BrowserPort, BrowserSocket } from "./browser-bridge";

/** Native binding, held only by the Worker; no account API token exists here. */
export type BrowserBinding = Pick<
  BrowserRun,
  "acquire" | "connectSession" | "closeSession"
>;

export function bindingBrowserPort(binding: BrowserBinding): BrowserPort {
  return {
    acquire: () =>
      binding.acquire({
        keepAlive: 600_000,
        guardrails: { allowedDomains: [] },
      }),
    async connect(sessionId) {
      const connection = await binding.connectSession(sessionId);
      const response = await connection.webSocket.fetch(
        "https://browser-binding.invalid",
        {
          headers: { Upgrade: "websocket" },
        },
      );
      if (!response.webSocket) throw new Error("provider_handshake_failed");
      return response.webSocket as unknown as BrowserSocket;
    },
    async close(sessionId) {
      await binding.closeSession(sessionId);
    },
  };
}
