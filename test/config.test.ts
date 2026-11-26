import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('returns defaults', () => {
    const c = loadConfig({}, 'linux', '/home/u');
    expect(c).toEqual({
      port: 4317, dataDir: '/home/u/.local/state/dev-dashboard', toasts: true,
      activeDays: 14, pollMs: 30_000, slowPollMs: 120_000, reposRefreshMs: 600_000, orgs: [],
    });
  });
  it('overrides port', () => {
    expect(loadConfig({ DEV_DASHBOARD_PORT: '5000' }, 'linux', '/h').port).toBe(5000);
  });
  it('ignores invalid port', () => {
    expect(loadConfig({ DEV_DASHBOARD_PORT: 'abc' }, 'linux', '/h').port).toBe(4317);
  });
  it('overrides data dir', () => {
    expect(loadConfig({ DEV_DASHBOARD_DATA_DIR: '/x/y' }, 'linux', '/h').dataDir).toBe('/x/y');
  });
  it('uses LOCALAPPDATA on Windows', () => {
    const c = loadConfig({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, 'win32', 'C:\\Users\\u');
    expect(c.dataDir).toBe('C:\\Users\\u\\AppData\\Local\\dev-dashboard');
  });
  it('DEV_DASHBOARD_TOASTS=0 or false disables toasts', () => {
    expect(loadConfig({ DEV_DASHBOARD_TOASTS: '0' }, 'linux', '/h').toasts).toBe(false);
    expect(loadConfig({ DEV_DASHBOARD_TOASTS: 'false' }, 'linux', '/h').toasts).toBe(false);
    expect(loadConfig({ DEV_DASHBOARD_TOASTS: '1' }, 'linux', '/h').toasts).toBe(true);
  });
  it('parses orgs list', () => {
    expect(loadConfig({ DEV_DASHBOARD_ORGS: 'a, b,,c' }, 'linux', '/h').orgs).toEqual(['a', 'b', 'c']);
  });
});
