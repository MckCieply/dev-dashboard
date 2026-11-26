import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Config } from './config.js';
import { Store } from './store.js';
import { createSessionSaver, loadSessions } from './sessions/persist.js';
import { createServer } from './server/http.js';
import { GitHubClient } from './github/client.js';
import { GitHubPoller } from './github/poller.js';
import { createAlertEngine } from './notify/rules.js';
import { createToaster, type Notify } from './notify/toast.js';

const SWEEP_MS = 60_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppOptions {
  config: Config;
  token: string | null;
  fetch?: typeof fetch;
  notify?: Notify;
  publicDir?: string;
  fontsDir?: string;
}

export interface App { url: string; store: Store; close(): Promise<void> }

export async function startApp(opts: AppOptions): Promise<App> {
  const { config } = opts;
  const log = (m: string): void => { process.stderr.write(`dev-dashboard: ${m}\n`); };
  const sessionsFile = path.join(config.dataDir, 'sessions.json');

  const store = new Store({ sessions: loadSessions(sessionsFile), toasts: config.toasts });
  const saver = createSessionSaver(sessionsFile);
  const engine = createAlertEngine();
  const toaster = createToaster({ enabled: () => store.get().toasts, notify: opts.notify, log });

  store.onChange((next, prev) => {
    toaster(engine.evaluate(next, prev));
    saver.save(store.getSessions());
  });

  const sweepTimer = setInterval(() => store.sweepSessions(), SWEEP_MS);
  sweepTimer.unref();

  const server = createServer({
    store,
    publicDir: opts.publicDir ?? path.join(ROOT, 'public'),
    fontsDir: opts.fontsDir ?? path.join(ROOT, 'node_modules'),
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (e) {
    clearInterval(sweepTimer);
    throw e;
  }
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const client = opts.token ? new GitHubClient({ token: opts.token, fetch: opts.fetch }) : null;
  const poller = new GitHubPoller({ client, store, config, log });
  poller.start();

  let closing: Promise<void> | null = null;
  return {
    url,
    store,
    close() {
      closing ??= (async () => {
        poller.stop();
        clearInterval(sweepTimer);
        saver.flush();
        server.closeAllConnections(); // ends open SSE streams so close() can resolve
        await new Promise<void>((resolve) => server.close(() => resolve()));
      })();
      return closing;
    },
  };
}
