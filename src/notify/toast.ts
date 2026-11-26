import path from 'node:path';
import { fileURLToPath } from 'node:url';
import notifier from 'node-notifier';
import type { Alert, AlertKind } from './rules.js';

const ICONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/toast');

// Windows toasts cannot be colored, so the icon carries the color and the sign.
export const iconPath = (kind: AlertKind): string => path.join(ICONS, `${kind}.png`);

export type Notify = (opts: { title: string; message: string; icon: string; sound: boolean; wait: false }) => void;

export function createToaster(opts: {
  enabled: () => boolean; notify?: Notify; log?: (m: string) => void;
}): (alerts: Alert[]) => void {
  const notify: Notify = opts.notify ?? ((o) => { notifier.notify(o); });
  const log = opts.log ?? (() => {});
  return (alerts) => {
    if (!opts.enabled()) return;
    for (const a of alerts) {
      try {
        notify({ title: a.title, message: a.message, icon: iconPath(a.kind), sound: true, wait: false });
      } catch (e) {
        log(`toast failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
}
