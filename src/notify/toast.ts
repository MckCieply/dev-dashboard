import notifier from 'node-notifier';
import type { Alert } from './rules.js';

export type Notify = (opts: { title: string; message: string; sound: boolean; wait: false }) => void;

export function createToaster(opts: {
  enabled: () => boolean; notify?: Notify; log?: (m: string) => void;
}): (alerts: Alert[]) => void {
  const notify: Notify = opts.notify ?? ((o) => { notifier.notify(o); });
  const log = opts.log ?? (() => {});
  return (alerts) => {
    if (!opts.enabled()) return;
    for (const a of alerts) {
      try {
        notify({ title: a.title, message: a.message, sound: true, wait: false });
      } catch (e) {
        log(`toast failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}
