import Link from "next/link";

const memoryTypes = [
  {
    type: "gotcha",
    emoji: "⚠️",
    title: "Gotcha",
    desc: "Traps and footguns that waste time. \"Don't use db.transaction() with neon-http driver.\"",
  },
  {
    type: "architecture",
    emoji: "🏗️",
    title: "Architecture",
    desc: "How the system is structured. \"Auth uses dual model: API keys for pay-per-token, OAuth for seat-based.\"",
  },
  {
    type: "pattern",
    emoji: "🔁",
    title: "Pattern",
    desc: "Recurring solutions. \"All API routes validate auth with getAuthContext() first.\"",
  },
  {
    type: "decision",
    emoji: "⚖️",
    title: "Decision",
    desc: "Why things are the way they are. \"Chose Pusher over SSE for real-time because of Vercel cold starts.\"",
  },
  {
    type: "discovery",
    emoji: "🔍",
    title: "Discovery",
    desc: "Found during investigation. \"The proxy.ts file handles all subdomain routing — don't add middleware.\"",
  },
  {
    type: "summary",
    emoji: "📋",
    title: "Summary",
    desc: "Condensed understanding. \"The worker claim flow: POST /claim → optimistic lock → return task.\"",
  },
];

const included = [
  {
    title: "No separate signup",
    desc: "Memory lives in your buildd team. Create a buildd account and it is already there — there is no second product to register for.",
  },
  {
    title: "No extra API key",
    desc: "The buildd API key your agents already use to claim tasks is the same key that reads and writes memory. One credential, one MCP server.",
  },
  {
    title: "Shared across the team",
    desc: "Memories are team-scoped, so every agent on every repo draws from the same pool. What one worker learns, the next one already knows.",
  },
];

const faqs = [
  {
    q: "How is memory scoped?",
    a: "Memory is team-scoped. Every agent in your team reads and writes the same pool, and memories can carry a project tag so you can narrow recall to one repo. Nothing is shared across teams.",
  },
  {
    q: "Do agents count as users?",
    a: "No. Memory is not seat-priced. Issue an API key per agent if you want separate audit trails — they all read and write the same team memory.",
  },
  {
    q: "Is there a standalone memory service?",
    a: "Not any more. Memory used to run as a separate hosted service with its own signup and its own API key. It is now a built-in buildd feature backed by buildd's own database, reachable through the buildd MCP server. There is no separate service to run or self-host.",
  },
  {
    q: "How do agents actually use it?",
    a: "Two MCP tools. Agents call recall before starting work to pull prior gotchas, patterns, and decisions, and learn to record what they discovered. Buildd also injects relevant memories into a task when a worker claims it.",
  },
];

const mcpConfig = `{
  "mcpServers": {
    "buildd": {
      "type": "http",
      "url": "https://buildd.dev/api/mcp",
      "headers": {
        "Authorization": "Bearer bld_..."
      }
    }
  }
}`;

export default function MemoryPage() {
  return (
    <main className="min-h-screen bg-[#2a2d3a] text-white">
      {/* Nav */}
      <div className="max-w-6xl mx-auto px-6 py-6 flex justify-between items-center">
        <Link href="/" className="text-xl font-bold">
          buildd
        </Link>
        <div className="flex gap-6 text-sm text-gray-400">
          <Link href="/memory" className="text-white">
            Memory
          </Link>
          <Link href="/" className="hover:text-white transition-colors">
            Task Queue
          </Link>
          <Link href="/app" className="hover:text-white transition-colors">
            Sign In
          </Link>
        </div>
      </div>

      {/* Hero */}
      <div className="max-w-4xl mx-auto px-6 pt-8 pb-16 text-center">
        <div className="space-y-6">
          {/* Badges */}
          <div className="flex flex-wrap justify-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Built into buildd
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              MCP-Native
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                />
              </svg>
              Team-Wide
            </span>
          </div>

          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Shared Memory for AI Agents
          </h1>
          <p className="text-xl text-gray-300 max-w-2xl mx-auto">
            Persistent team knowledge that follows your agents across sessions.
            Every agent starts with the full context of everything your team has
            learned &mdash; built into buildd, not a separate product to buy.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap justify-center gap-4 pt-2">
            <Link
              href="/app"
              className="inline-flex items-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors"
            >
              Get Started Free
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 7l5 5m0 0l-5 5m5-5H6"
                />
              </svg>
            </Link>
            <a
              href="https://docs.buildd.dev/memory"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
                />
              </svg>
              Read the docs
            </a>
          </div>
        </div>
      </div>

      {/* Problem Statement */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <div className="bg-white/5 rounded-xl p-8 border border-white/10 text-center">
          <p className="text-lg md:text-xl text-gray-300 leading-relaxed">
            Claude Code memory is local. Cursor has none. Your agents forget
            everything between sessions.
          </p>
        </div>
      </div>

      {/* Setup Code Block */}
      <div className="max-w-4xl mx-auto px-6 pb-16">
        <h2 className="text-2xl font-bold text-center mb-2">
          One connection, memory included
        </h2>
        <p className="text-gray-400 text-center mb-6 max-w-2xl mx-auto">
          Point your agent at the buildd MCP server with the buildd API key you
          create in Settings. Memory comes with it &mdash; no memory-only key, no
          extra package to install.
        </p>
        <div className="bg-[#1a1c24] rounded-xl border border-white/10 overflow-hidden">
          {/* Terminal header */}
          <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div
                className="w-3 h-3 rounded-full bg-red-500/80"
                aria-hidden="true"
              />
              <div
                className="w-3 h-3 rounded-full bg-yellow-500/80"
                aria-hidden="true"
              />
              <div
                className="w-3 h-3 rounded-full bg-green-500/80"
                aria-hidden="true"
              />
              <span className="ml-2 text-sm text-gray-500">.mcp.json</span>
            </div>
          </div>
          <div className="p-6">
            <pre className="text-sm text-gray-300 font-mono leading-relaxed">
              <code>{mcpConfig}</code>
            </pre>
          </div>
        </div>
      </div>

      {/* How It Works */}
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-12">How it works</h2>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">1</span>
            </div>
            <h3 className="font-semibold mb-2">Connect via MCP</h3>
            <p className="text-sm text-gray-300">
              Add the buildd MCP server to your project. Works with Claude Code,
              Cursor, Windsurf &mdash; any MCP-compatible agent.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">2</span>
            </div>
            <h3 className="font-semibold mb-2">Agents save discoveries</h3>
            <p className="text-sm text-gray-300">
              As agents work they call <code>learn</code> to record gotchas,
              patterns, and architecture decisions. Memories are typed, tagged,
              and searchable.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">3</span>
            </div>
            <h3 className="font-semibold mb-2">Every session starts informed</h3>
            <p className="text-sm text-gray-300">
              Agents call <code>recall</code> before they start, and claimed
              tasks arrive with relevant memories attached. Your 10th agent
              avoids the mistakes of your first.
            </p>
          </div>
        </div>
      </div>

      {/* Memory Types Grid */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-4">Memory types</h2>
        <p className="text-gray-400 text-center mb-12 max-w-2xl mx-auto">
          Structured knowledge, not raw text. Each memory has a type, tags, and
          relevance scoring.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {memoryTypes.map((m) => (
            <div
              key={m.type}
              className="bg-white/5 rounded-xl p-6 border border-white/10"
            >
              <div className="flex items-center gap-3 mb-3">
                <span className="text-2xl" aria-hidden="true">
                  {m.emoji}
                </span>
                <h3 className="font-semibold">{m.title}</h3>
              </div>
              <p className="text-sm text-gray-400">{m.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Included with buildd (kept id="pricing" so existing inbound links land here) */}
      <div id="pricing" className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-4">
          Included with buildd
        </h2>
        <p className="text-gray-400 text-center mb-12 max-w-2xl mx-auto">
          Memory is a buildd feature, not an add-on. Nothing separate to
          subscribe to, provision, or wire up.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {included.map((item) => (
            <div
              key={item.title}
              className="bg-white/5 rounded-xl p-6 md:p-8 border border-white/10"
            >
              <h3 className="text-lg font-semibold mb-3">{item.title}</h3>
              <p className="text-sm text-gray-300">{item.desc}</p>
            </div>
          ))}
        </div>
      </div>

      {/* FAQ */}
      <div className="max-w-3xl mx-auto px-6 pb-20">
        <h2 className="text-2xl font-bold text-center mb-8">FAQ</h2>
        <div className="space-y-6">
          {faqs.map((faq) => (
            <div
              key={faq.q}
              className="bg-white/5 rounded-lg p-6 border border-white/10"
            >
              <h3 className="font-semibold mb-2">{faq.q}</h3>
              <p className="text-sm text-gray-300">{faq.a}</p>
            </div>
          ))}
        </div>
      </div>

      {/* CTA */}
      <div className="max-w-4xl mx-auto px-6 pb-20 text-center">
        <h2 className="text-2xl font-bold mb-3">
          Stop losing knowledge between sessions
        </h2>
        <p className="text-gray-300 mb-6">
          Sign in to buildd, create an API key, and your agents share memory
          from their next session on.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <Link
            href="/app"
            className="inline-flex items-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors"
          >
            Get Started Free
          </Link>
          <a
            href="https://docs.buildd.dev/memory"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
          >
            Read the docs
          </a>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-400 text-sm">
              buildd &mdash; Shared memory for AI agents
            </p>
            <div className="flex gap-6 text-sm text-gray-400">
              <Link
                href="/memory"
                className="hover:text-white transition-colors"
              >
                Memory
              </Link>
              <Link href="/" className="hover:text-white transition-colors">
                Task Queue
              </Link>
              <a
                href="https://docs.buildd.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors"
              >
                Docs
              </a>
              <a
                href="mailto:hello@buildd.dev"
                className="hover:text-white transition-colors"
              >
                Contact
              </a>
              <Link href="/app" className="hover:text-white transition-colors">
                Sign In
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
