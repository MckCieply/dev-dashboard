import { describe, expect, it, vi } from 'vitest';
import { createToaster } from '../../src/notify/toast.js';

const alerts = [{ key: 'a', title: 'T1', message: 'M1' }, { key: 'b', title: 'T2', message: 'M2' }];

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
    expect(notify).toHaveBeenCalledWith({ title: 'T1', message: 'M1', sound: true, wait: false });
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
