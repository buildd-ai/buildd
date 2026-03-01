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

const tiers = [
  {
    name: "Free",
    price: "$0",
    period: "",
    highlighted: false,
    cta: { label: "Get Started Free", href: "https://memory.buildd.dev" },
    limits: [
      "1 workspace",
      "200 memories",
      "2 API keys",
      "500 context calls/mo",
      "1k search + write/mo",
    ],
  },
  {
    name: "Pro",
    price: "$12",
    period: "/mo",
    badge: "Most Popular",
    highlighted: true,
    cta: { label: "Get Started", href: "https://memory.buildd.dev" },
    limits: [
      "3 workspaces",
      "5k memories",
      "20 API keys",
      "10k context calls/mo",
      "25k search + write/mo",
    ],
  },
  {
    name: "Scale",
    price: "$49",
    period: "/mo",
    highlighted: false,
    cta: { label: "Get Started", href: "https://memory.buildd.dev" },
    limits: [
      "Unlimited workspaces",
      "50k memories",
      "Unlimited API keys",
      "100k context calls/mo",
      "250k search + write/mo",
    ],
  },
];

const faqs = [
  {
    q: "What's a workspace?",
    a: "A workspace maps to a project or repo. Each workspace has its own memories, API keys, and usage limits. Agents in one workspace can't see memories from another.",
  },
  {
    q: "Do agents count as users?",
    a: "No. You pay for knowledge capacity, not seats. Connect as many agents as you want — each gets an API key, and they all share the workspace's memory pool.",
  },
  {
    q: "Can I self-host?",
    a: "Yes. Memory is fully open source. Run it on your own infrastructure with your own Postgres database. The hosted version at memory.buildd.dev is the easiest way to get started.",
  },
  {
    q: "How does the free tier work?",
    a: "Sign up, create a workspace, connect your agents. No credit card required. You get 200 memories and 500 context calls per month — enough to evaluate Memory on a real project.",
  },
];

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
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  clipRule="evenodd"
                />
              </svg>
              Open Source
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
                  d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                />
              </svg>
              API-First
            </span>
          </div>

          <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
            Shared Memory for AI Agents
          </h1>
          <p className="text-xl text-gray-300 max-w-2xl mx-auto">
            Persistent team knowledge that follows your agents across sessions.
            Every agent starts with the full context of everything your team has
            learned.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap justify-center gap-4 pt-2">
            <a
              href="https://memory.buildd.dev"
              target="_blank"
              rel="noopener noreferrer"
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
            </a>
            <a
              href="https://github.com/buildd-ai/memory"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                  clipRule="evenodd"
                />
              </svg>
              View on GitHub
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
        <h2 className="text-2xl font-bold text-center mb-6">
          3 lines to connect
        </h2>
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
              <code>{`{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@buildd/memory-plugin"],
      "env": {
        "BUILDD_MEMORY_API_KEY": "bld_mem_..."
      }
    }
  }
}`}</code>
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
              Add the MCP config to your project. Works with Claude Code,
              Cursor, Windsurf &mdash; any MCP-compatible agent.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">2</span>
            </div>
            <h3 className="font-semibold mb-2">Agents save discoveries</h3>
            <p className="text-sm text-gray-300">
              As agents work, they record gotchas, patterns, and architecture
              decisions. Memories are typed, tagged, and searchable.
            </p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">3</span>
            </div>
            <h3 className="font-semibold mb-2">Every session starts informed</h3>
            <p className="text-sm text-gray-300">
              New sessions automatically load relevant memories. Your 10th agent
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

      {/* Pricing */}
      <div id="pricing" className="max-w-6xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-4">
          Agent-native pricing
        </h2>
        <p className="text-gray-400 text-center mb-12 max-w-2xl mx-auto">
          One API key per agent. One workspace per project. Pay for knowledge,
          not seats.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {tiers.map((tier) => (
            <div
              key={tier.name}
              className={`rounded-xl p-6 md:p-8 border flex flex-col relative ${
                tier.highlighted
                  ? "border-amber-500/50 bg-amber-500/5 ring-1 ring-amber-500/20"
                  : "border-white/10 bg-white/5"
              }`}
            >
              {"badge" in tier && tier.badge && (
                <span className="absolute -top-3 left-6 px-3 py-1 text-xs font-semibold bg-amber-500 text-black rounded-full">
                  {tier.badge}
                </span>
              )}

              <div className="mb-6">
                <h3 className="text-xl font-semibold mb-1">{tier.name}</h3>
              </div>

              <div className="mb-6">
                <span className="text-4xl font-bold">{tier.price}</span>
                {tier.period && (
                  <span className="text-gray-400 ml-1">{tier.period}</span>
                )}
              </div>

              <a
                href={tier.cta.href}
                target="_blank"
                rel="noopener noreferrer"
                className={`block text-center px-6 py-3 font-semibold rounded-lg transition-colors mb-8 ${
                  tier.highlighted
                    ? "bg-amber-500 hover:bg-amber-400 text-black"
                    : "bg-white/10 hover:bg-white/20 border border-white/20 text-white"
                }`}
              >
                {tier.cta.label}
              </a>

              <ul className="space-y-3 flex-1">
                {tier.limits.map((limit) => (
                  <li
                    key={limit}
                    className="flex items-start gap-2 text-sm text-gray-300"
                  >
                    <svg
                      className="w-4 h-4 text-green-400 mt-0.5 flex-shrink-0"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                    {limit}
                  </li>
                ))}
              </ul>
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
          Connect Memory in 3 lines. Your agents will thank you.
        </p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="https://memory.buildd.dev"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded-lg transition-colors"
          >
            Get Started Free
          </a>
          <a
            href="https://github.com/buildd-ai/memory"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
          >
            <svg
              className="w-4 h-4"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                clipRule="evenodd"
              />
            </svg>
            View on GitHub
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
                href="https://github.com/buildd-ai/memory"
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
