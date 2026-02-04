"use client";

export default function OpenClawPage() {
  return (
    <main className="min-h-screen bg-[#2a2d3a] text-white">
      {/* Nav */}
      <div className="max-w-6xl mx-auto px-6 pt-8 pb-4">
        <a href="/" className="text-sm text-gray-500 hover:text-gray-300 transition-colors">
          &larr; buildd.dev
        </a>
      </div>

      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-16">
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-4xl md:text-5xl font-bold">Buildd + OpenClaw</h1>
          </div>
          <p className="text-xl text-gray-300 max-w-2xl">
            Coordinate your OpenClaw agents with a central task queue.
            Create tasks in the dashboard, OpenClaw picks them up automatically.
          </p>
        </div>
      </div>

      {/* How it works */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <h2 className="text-2xl font-bold mb-8">How it works</h2>
        <div className="space-y-6">
          {[
            {
              step: "1",
              title: "Configure webhook",
              desc: "Point your workspace to your OpenClaw Gateway's /hooks/agent endpoint.",
              color: "fuchsia",
            },
            {
              step: "2",
              title: "Create tasks",
              desc: "From the dashboard, API, or MCP — tasks are dispatched to OpenClaw instantly.",
              color: "violet",
            },
            {
              step: "3",
              title: "Agent works autonomously",
              desc: "OpenClaw receives the task, investigates, writes code, commits, and opens PRs.",
              color: "cyan",
            },
            {
              step: "4",
              title: "Track progress",
              desc: "Monitor every agent in real-time. Send instructions mid-task if needed.",
              color: "green",
            },
          ].map((item) => (
            <div key={item.step} className="flex gap-4 items-start">
              <div className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center text-lg font-bold ${
                item.color === "fuchsia" ? "bg-fuchsia-500/20 text-fuchsia-400" :
                item.color === "violet" ? "bg-violet-500/20 text-violet-400" :
                item.color === "cyan" ? "bg-cyan-500/20 text-cyan-400" :
                "bg-green-500/20 text-green-400"
              }`}>
                {item.step}
              </div>
              <div>
                <h3 className="text-lg font-semibold">{item.title}</h3>
                <p className="text-gray-400 mt-1">{item.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Architecture diagram as text */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <div className="bg-[#1a1c24] rounded-xl border border-white/10 overflow-hidden">
          <div className="flex items-center gap-2 px-4 py-3 bg-white/5 border-b border-white/10">
            <span className="text-sm text-gray-500">Data flow</span>
          </div>
          <div className="p-6 font-mono text-sm text-gray-300 leading-relaxed whitespace-pre">{
`Dashboard / API / MCP
        │
        ▼
   POST /api/tasks ──► Pusher (local-ui workers)
        │
        ├──► POST /hooks/agent (OpenClaw webhook)
        │         │
        │         ▼
        │    OpenClaw Gateway
        │         │
        │         ▼
        │    Agent session starts
        │         │
        │    ┌────┴────┐
        │    │ Read    Edit    Bash    Commit │
        │    └────┬────┘
        │         │
        │         ▼
        └──── PATCH /api/workers/:id (progress)
              POST  /api/github/pr (PR creation)`
          }</div>
        </div>
      </div>

      {/* Setup */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <h2 className="text-2xl font-bold mb-8">Quick setup</h2>

        <div className="space-y-8">
          {/* Step 1 */}
          <div>
            <h3 className="text-lg font-semibold mb-3">1. Enable webhooks in OpenClaw</h3>
            <div className="bg-[#1a1c24] rounded-xl border border-white/10 p-6">
              <code className="text-sm text-gray-300 font-mono whitespace-pre">{
`# ~/.openclaw/config.yaml
hooks:
  enabled: true
  token: "your-secret-token"
  path: /hooks`
              }</code>
            </div>
          </div>

          {/* Step 2 */}
          <div>
            <h3 className="text-lg font-semibold mb-3">2. Configure in Buildd</h3>
            <p className="text-gray-400 mb-3">
              Go to your workspace → <strong className="text-gray-200">Configure</strong> → <strong className="text-gray-200">Webhook Dispatch</strong>
            </p>
            <div className="bg-white/5 rounded-xl border border-white/10 p-6 space-y-3">
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-20">URL</span>
                <code className="text-sm text-gray-300 font-mono">http://your-server:18789/hooks/agent</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-20">Token</span>
                <code className="text-sm text-gray-300 font-mono">your-secret-token</code>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 w-20">Status</span>
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 bg-green-500/20 rounded-full text-xs text-green-400">
                  Enabled
                </span>
              </div>
            </div>
          </div>

          {/* Step 3 */}
          <div>
            <h3 className="text-lg font-semibold mb-3">3. Optional: install the Buildd skill</h3>
            <p className="text-gray-400 mb-3">
              Let your OpenClaw agent report progress back to Buildd.
            </p>
            <div className="bg-[#1a1c24] rounded-xl border border-white/10 p-6">
              <code className="text-sm text-gray-300 font-mono whitespace-pre">{
`npm install @buildd/openclaw-skill

# Or copy the skill into your workspace
cp -r node_modules/@buildd/openclaw-skill/SKILL.md \\
  ~/.openclaw/workspace/skills/buildd/SKILL.md`
              }</code>
            </div>
          </div>
        </div>
      </div>

      {/* Also works with */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <div className="bg-white/5 rounded-xl border border-white/10 p-6">
          <h3 className="font-semibold mb-2">Not using OpenClaw?</h3>
          <p className="text-gray-400 text-sm">
            Buildd's webhook dispatch works with any agent that accepts HTTP POST requests.
            The payload format is simple JSON — integrate with your own agents, n8n workflows,
            or any automation platform.{" "}
            <a href="https://github.com/buildd-ai/buildd" className="text-gray-300 underline hover:text-white">
              See the docs →
            </a>
          </p>
        </div>
      </div>

      {/* CTA */}
      <div className="max-w-4xl mx-auto px-6 pb-20">
        <div className="flex flex-wrap gap-4">
          <a
            href="/app"
            className="px-6 py-3 bg-white text-black font-medium rounded-lg hover:opacity-90 transition-opacity"
          >
            Open Dashboard
          </a>
          <a
            href="https://github.com/buildd-ai/buildd"
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-3 border border-white/20 rounded-lg hover:bg-white/5 transition-colors"
          >
            View on GitHub
          </a>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-400 text-sm">
              buildd - Open source task queue for AI agents
            </p>
            <div className="flex gap-6 text-sm text-gray-400">
              <a
                href="https://github.com/buildd-ai/buildd"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors"
              >
                GitHub
              </a>
              <a
                href="mailto:hello@buildd.dev"
                className="hover:text-white transition-colors"
              >
                Contact
              </a>
              <a
                href="/"
                className="hover:text-white transition-colors"
              >
                Home
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
