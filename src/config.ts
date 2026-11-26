import path from 'node:path';
import os from 'node:os';

export interface Config { port: number; dataDir: string; toasts: boolean; activeDays: number; pollMs: number; slowPollMs: number; reposRefreshMs: number; orgs: string[] }

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): Config {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const portN = Number(env.DEV_DASHBOARD_PORT);
  const port = Number.isInteger(portN) && portN > 0 && portN < 65536 ? portN : 4317;

  let dataDir = env.DEV_DASHBOARD_DATA_DIR;
  if (!dataDir) {
    dataDir = platform === 'win32'
      ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'dev-dashboard')
      : p.join(home, '.local', 'state', 'dev-dashboard');
  }

  const t = (env.DEV_DASHBOARD_TOASTS ?? '').trim().toLowerCase();
  const toasts = !(t === '0' || t === 'false');

  const orgs = (env.DEV_DASHBOARD_ORGS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  return { port, dataDir, toasts, activeDays: 14, pollMs: 30_000, slowPollMs: 120_000, reposRefreshMs: 600_000, orgs };
}
