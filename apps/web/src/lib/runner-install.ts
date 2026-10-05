/**
 * The one install-and-connect instruction for the buildd runner.
 *
 * Every screen that tells someone how to start a runner renders these lines
 * (via `components/RunnerInstallSteps`) instead of typing its own. They match
 * the install block on buildd.dev and the closing output of
 * `apps/runner/install.sh`:
 *
 *   1. the one-line installer (buildd.dev/install.sh redirects to the script),
 *   2. reload the shell: the installer adds ~/.local/bin to the shell rc, but
 *      that export only applies inside the piped installer's own subshell, so
 *      `buildd` is not on PATH in the terminal that ran the one-liner,
 *   3. `buildd login`, which opens the browser to connect the account,
 *   4. bare `buildd`, which starts the runner.
 *
 * The runner is headless by default: nothing serves a page on localhost unless
 * it is started with `--debug`, and with no login it idles. So `buildd login`
 * is a step of its own, never replaced by "open localhost:8766".
 * There is no `buildd run`.
 */
export const RUNNER_INSTALL_COMMANDS = [
  'curl -fsSL https://buildd.dev/install.sh | bash',
  'exec $SHELL',
  'buildd login',
  'buildd',
] as const;

/** For a machine with no browser: the terminal flavour of `buildd login`. */
export const RUNNER_HEADLESS_LOGIN = 'buildd login --device';

/** Keeps the runner going after the terminal closes; replaces bare `buildd`. */
export const RUNNER_SERVICE_INSTALL = 'buildd service install';
