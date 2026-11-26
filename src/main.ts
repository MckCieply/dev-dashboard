import { loadConfig } from './config.js';
import { resolveToken } from './github/client.js';
import { startApp } from './app.js';

const config = loadConfig();
const token = await resolveToken();

let app;
try {
  app = await startApp({ config, token });
} catch (e) {
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${config.port} zajęty — czy dashboard już działa?`);
  } else {
    console.error(`dev-dashboard: ${(e as Error).message}`);
  }
  process.exit(1);
}

console.log(`Dev dashboard: ${app.url}`);
if (!token) console.warn('Brak tokenu GitHub (gh auth login albo GITHUB_TOKEN) — panele GitHub będą puste.');

const shutdown = (): void => { void app.close().then(() => process.exit(0)); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
