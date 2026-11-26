import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createToaster, iconPath } from '../../src/notify/toast.js';
import { ALERT_KINDS, type Alert } from '../../src/notify/rules.js';

const alerts: Alert[] = [{ key: 'a', kind: 'merged', title: 'T1', message: 'M1' }, { key: 'b', kind: 'ready', title: 'T2', message: 'M2' }];

describe('createToaster', () => {
  it('does nothing when disabled', () => {
    const notify = vi.fn();
    createToaster({ enabled: () => false, notify })(alerts);
    expect(notify).not.toHaveBeenCalled();
  });
  it('sends one toast per alert', () => {
    const notify = vi.fn();
    createToaster({ enabled: () => true, notify })(alerts);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith({ title: 'T1', message: 'M1', icon: iconPath('merged'), sound: true, wait: false });
  });
  it('has its own PNG icon for every alert kind', () => {
    const bytes = ALERT_KINDS.map((k) => {
      expect(path.isAbsolute(iconPath(k))).toBe(true);
      const b = fs.readFileSync(iconPath(k));
      expect([...b.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
      expect(b.length).toBeLessThan(200_000);
      return b.toString('base64');
    });
    expect(new Set(bytes).size).toBe(6);
  });
  it('does not pass an unregistered appID', () => {
    const notify = vi.fn();
    createToaster({ enabled: () => true, notify })(alerts);
    expect(notify.mock.calls[0][0]).not.toHaveProperty('appID');
  });
  it('catches notify errors and logs', () => {
    const log = vi.fn();
    const notify = vi.fn(() => { throw new Error('boom'); });
    expect(() => createToaster({ enabled: () => true, notify, log })(alerts)).not.toThrow();
    expect(log).toHaveBeenCalledTimes(2);
  });
});
