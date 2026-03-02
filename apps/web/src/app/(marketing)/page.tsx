export default function LandingPage() {

  return (
    <main className="min-h-screen bg-[#2a2d3a] text-white">
      {/* Hero Section */}
      <div className="max-w-6xl mx-auto px-6 pt-16 pb-12">
        <div className="text-center space-y-6">
          {/* Hero Logo */}
          <div className="relative mx-auto w-full max-w-md md:max-w-lg lg:max-w-xl">
            <picture>
              <source
                media="(min-width: 1024px)"
                srcSet="/hero/logo-desktop.webp"
                type="image/webp"
              />
              <source
                media="(min-width: 768px)"
                srcSet="/hero/logo-tablet.webp"
                type="image/webp"
              />
              <source srcSet="/hero/logo-mobile.webp" type="image/webp" />
              <img
                src="/hero/logo-desktop.png"
                alt="Buildd"
                className="w-full h-auto"
                width={1600}
                height={1194}
              />
            </picture>
          </div>

          {/* Badges */}
          <div className="flex flex-wrap justify-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              Open Source
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-white/10 border border-white/20 rounded-full text-sm text-gray-300">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              Self-Hostable
            </span>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-500/20 border border-indigo-500/30 rounded-full text-sm text-indigo-300">
              Alpha &mdash; Everything Free
            </span>
          </div>

          <div className="space-y-4">
            <h1 className="text-3xl md:text-4xl font-bold tracking-tight">
              Task Queue + Shared Memory for AI Agents
            </h1>
            <p className="text-lg md:text-xl text-gray-300 max-w-2xl mx-auto">
              Coordinate your Claude agents from one dashboard. Tasks go in, PRs come out. Knowledge compounds automatically so your 10th task avoids the mistakes of your first.
            </p>
          </div>

          {/* CTAs */}
          <div className="flex flex-wrap justify-center gap-4 pt-2">
            <a
              href="/app"
              className="inline-flex items-center gap-2 px-6 py-3 bg-fuchsia-500 hover:bg-fuchsia-400 text-white font-semibold rounded-lg transition-colors"
            >
              Get Started
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
              </svg>
            </a>
            <a
              href="https://docs.buildd.dev"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
            >
              Read the Docs
            </a>
            <a
              href="https://github.com/buildd-ai/buildd"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 px-6 py-3 bg-white/10 hover:bg-white/20 border border-white/20 text-white font-medium rounded-lg transition-colors"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
              </svg>
              GitHub
            </a>
          </div>
        </div>
      </div>

      {/* Install Section */}
      <div className="max-w-4xl mx-auto px-6 pb-12">
        <div className="bg-[#1a1c24] rounded-xl border border-white/10 overflow-hidden">
          {/* Terminal header */}
          <div className="flex items-center justify-between px-4 py-3 bg-white/5 border-b border-white/10">
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500/80" aria-hidden="true" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/80" aria-hidden="true" />
              <div className="w-3 h-3 rounded-full bg-green-500/80" aria-hidden="true" />
              <span className="ml-2 text-sm text-gray-500">Terminal</span>
            </div>
          </div>
          {/* Install command */}
          <div className="p-6 space-y-3">
            <div className="flex items-center gap-3">
              <span className="text-gray-500 select-none" aria-hidden="true">$</span>
              <code className="text-gray-200 font-mono text-sm md:text-base flex-1">
                curl -fsSL https://buildd.dev/install.sh | bash
              </code>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-gray-500 select-none" aria-hidden="true">$</span>
              <code className="text-gray-300 font-mono text-sm md:text-base flex-1">
                buildd login
              </code>
            </div>
          </div>
        </div>
      </div>

      {/* Screenshot */}
      <div className="max-w-3xl mx-auto px-6 pb-16">
        <div className="rounded-xl overflow-hidden border border-white/10 shadow-2xl shadow-black/50">
          <img
            src="/local-ui.png"
            alt="Buildd local UI showing an active worker executing a task with real-time progress"
            className="w-full h-auto"
          />
        </div>
      </div>

      {/* How It Works */}
      <div className="max-w-4xl mx-auto px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-4">How it works</h2>
        <p className="text-center text-sm text-gray-400 mb-12">
          Works with your existing Anthropic subscription &mdash; no pay-per-token fees.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-fuchsia-500/20 border border-fuchsia-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-fuchsia-400 font-semibold">1</span>
            </div>
            <h3 className="font-semibold mb-2">Install &amp; login</h3>
            <p className="text-sm text-gray-300">One command installs. <code className="text-white">buildd login</code> authenticates everything &mdash; CLI, MCP, and agents.</p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-violet-500/20 border border-violet-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-violet-400 font-semibold">2</span>
            </div>
            <h3 className="font-semibold mb-2">Create tasks</h3>
            <p className="text-sm text-gray-300">From the dashboard, CLI, API &mdash; or set a cron schedule and let them run automatically.</p>
          </div>
          <div className="text-center">
            <div className="w-10 h-10 rounded-full bg-amber-500/20 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
              <span className="text-amber-400 font-semibold">3</span>
            </div>
            <h3 className="font-semibold mb-2">Agents build</h3>
            <p className="text-sm text-gray-300">Workers claim tasks, branch, code, and open PRs. <a href="/memory" className="text-amber-400 hover:text-amber-300 underline">Shared memory</a> means every session starts with full context.</p>
          </div>
        </div>
      </div>

      {/* Features Section - 4 core cards */}
      <div className="max-w-6xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-2 gap-8">
          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-fuchsia-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-fuchsia-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Multi-Agent Coordination</h3>
            <p className="text-gray-300">
              Run Claude agents on laptops, VMs, or GitHub Actions.
              One dashboard controls them all &mdash; monitor progress, send instructions mid-task, and review plans before code is written.
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-amber-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-amber-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Shared Memory</h3>
            <p className="text-gray-300">
              Persistent team knowledge via <a href="/memory" className="text-amber-400 hover:text-amber-300 underline">Buildd Memory</a>.
              Agents record gotchas, patterns, and decisions &mdash; future sessions start with full context.
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-fuchsia-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg className="w-6 h-6 text-fuchsia-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold mb-2">Scheduled Tasks</h3>
            <p className="text-gray-300">
              Set a cron schedule and your agents run automatically &mdash; nightly test suites, daily PR reviews, weekly dependency audits.
              Define the task template once, and Buildd dispatches on cadence.
            </p>
          </div>

          <div className="bg-white/5 rounded-xl p-6 border border-white/10 backdrop-blur-sm">
            <div className="w-12 h-12 bg-violet-500/20 rounded-lg flex items-center justify-center mb-4">
              <svg
                className="w-6 h-6 text-violet-400"
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
            </div>
            <h3 className="text-xl font-semibold mb-2">GitHub-Native</h3>
            <p className="text-gray-300">
              Agents create branches, commit code, and open PRs automatically.
              Full webhook integration and repo-level workspace isolation.
            </p>
          </div>
        </div>
      </div>

      {/* Alpha CTA */}
      <div className="max-w-4xl mx-auto px-6 py-16 text-center">
        <h2 className="text-2xl font-bold mb-3">Free while in alpha</h2>
        <p className="text-gray-300 mb-6">All features unlocked. Unlimited workspaces, workers, and tasks. No credit card required.</p>
        <div className="flex flex-wrap justify-center gap-4">
          <a
            href="/app"
            className="inline-flex items-center gap-2 px-6 py-3 bg-fuchsia-500 hover:bg-fuchsia-400 text-white font-semibold rounded-lg transition-colors"
          >
            Get Started Free
          </a>
        </div>
      </div>

      {/* Footer */}
      <footer className="border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-gray-400 text-sm">
              buildd &mdash; Task queue + shared memory for AI agents
            </p>
            <div className="flex gap-6 text-sm text-gray-400">
              <a
                href="/memory"
                className="hover:text-white transition-colors"
              >
                Memory
              </a>
              <a
                href="https://docs.buildd.dev"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-white transition-colors"
              >
                Docs
              </a>
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
                href="/app"
                className="hover:text-white transition-colors"
              >
                Sign In
              </a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
