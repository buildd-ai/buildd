/**
 * Child process for runner-shutdown-broker.test.ts: the REAL credential broker
 * started the way the runner starts it, plus the runner's one stop handler,
 * with a pause that takes a while. Prints each step so the parent can check
 * the order. PROBE_BROKER_SIGNALS=1 starts the broker with its own handlers
 * (what the runner did before), to show why that cuts the pause short.
 */
import { credentialBroker } from '../../src/broker';
import { installRunnerShutdown } from '../../src/restart-resume';

const say = (l: string) => process.stdout.write(`${l}\n`);
credentialBroker.start(
  { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:1' },
  { signalHandlers: process.env.PROBE_BROKER_SIGNALS === '1' },
);
installRunnerShutdown({
  pauseAgents: async () => {
    say('pause start');
    await new Promise(r => setTimeout(r, Number(process.env.PROBE_PAUSE_MS || 1500)));
    say('pause done');
  },
  releaseBroker: async () => { await credentialBroker.shutdown(); say('broker released'); },
  exit: (code) => { say(`exit ${code}`); process.exit(code); },
  log: () => {},
});
say('ready');
setInterval(() => {}, 1_000);
