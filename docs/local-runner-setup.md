# Local runner: chat and search on your own machine

A team can serve its knowledge search (embeddings) and its chat from the Ollama
on one of its own runners. Nothing is stored: there is no key and no open port.
The runner asks buildd for work over its existing connection, runs it on its
local Ollama and sends the answer back. The contract is
`docs/specs/local-runner-provider.md`.

## Set it up

1. **Ollama on the runner's machine.** Install it (https://ollama.com) and keep
   it on loopback, its default. Pull the models you want:
   ```bash
   ollama pull nomic-embed-text   # embeddings, 768 dimensions
   ollama pull <a chat model>
   ```
2. **Update and restart the runner.** It finds Ollama itself and lists the
   models it serves in its next heartbeat. `buildd doctor` prints a line for it.
   To keep a runner out of this, set `BUILDD_LOCAL_MODEL_RELAY=0`.
3. **Settings › Providers.** A **Local runner** row appears once a runner has
   listed models (before that, one line says how to get one). Open it, choose
   the runner and a chat model, Save. Saving a chat model also makes chat use
   the runner; choosing None stops that. The row shows whether the runner is
   Online or Offline and when it last completed a call.
4. **Search.** In **Used for › Embeddings** choose **Local runner**, then a
   runner and an embedding model; each model shows its vector size. Sizes 768,
   1024 and 1536 are supported; any other is greyed out.
5. **Chat.** Nothing more to do: step 3 routes chat to the runner. If you
   later pick another provider for chat under **Used for › Chat**, pick the
   chat model on the Local runner row again to route it back.

Changing the embedding model or its size means the stored vectors no longer
match. Knowledge embedded with the old model is found by keyword until it is
indexed again.

## When the runner is offline

There is no fallback to a paid provider. Search runs on keywords only, and chat
answers that the runner is unavailable until it is back. Change the choice in
Settings if you want something else.

## Alternative: a tunnel to a custom endpoint

For a machine that is always on and already reachable, or when you want the
lowest query latency from the server, expose Ollama's OpenAI-compatible root
(`/v1`) with an HTTPS tunnel (Tailscale Funnel, cloudflared) and connect it as
the team's LiteLLM gateway, then pick that provider for embeddings with the
Ollama tag as the model. This stays available for always-on hosting. The
trade-offs: the model is reachable from the internet and the tunnel's own
access control is the only gate; every query crosses the tunnel; chat needs the
gateway too, because a custom endpoint is not offered for chat. Prefer the local
runner for anything behind NAT or where the model must stay private.
