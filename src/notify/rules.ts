import type { DashboardState, PullRequest } from '../types.js';

// Each kind has its own toast icon in assets/toast/.
export const ALERT_KINDS = ['needs-human', 'checks-failed', 'ready', 'merged', 'runner-offline', 'runner-online'] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
export interface Alert { key: string; kind: AlertKind; title: string; message: string }

const OFFLINE_POLLS = 2;

// Only GitHub and runner events alert. Claude sessions are shown on the page, never toasted.
export function createAlertEngine(): { evaluate(next: DashboardState, prev: DashboardState): Alert[] } {
  const streak = new Map<number, number>();
  const alertedOffline = new Set<number>();
  const needingHuman = new Set<string>();
  const seenMerged = new Set<string>();
  let runnersBaselined = false;
  let prsBaselined = false;

  function runnerAlerts(next: DashboardState, prev: DashboardState, out: Alert[]): void {
    const stamp = next.collectors.runners.lastSuccessAt;
    if (stamp === null) return;
    if (!runnersBaselined) {
      runnersBaselined = true;
      for (const r of next.runners) if (r.state === 'offline') alertedOffline.add(r.id);
      return;
    }
    if (stamp === prev.collectors.runners.lastSuccessAt) return; // not a new poll
    const seen = new Set<number>();
    for (const r of next.runners) {
      seen.add(r.id);
      if (r.state === 'offline') {
        const n = (streak.get(r.id) ?? 0) + 1;
        streak.set(r.id, n);
        if (n >= OFFLINE_POLLS && !alertedOffline.has(r.id)) {
          alertedOffline.add(r.id);
          out.push({ key: `runner:${r.id}:offline`, kind: 'runner-offline', title: `Runner offline: ${r.name}`, message: r.os });
        }
      } else {
        streak.set(r.id, 0);
        if (alertedOffline.delete(r.id)) {
          out.push({ key: `runner:${r.id}:online`, kind: 'runner-online', title: `Runner znowu online: ${r.name}`, message: r.os });
        }
      }
    }
    for (const id of [...streak.keys()]) if (!seen.has(id)) streak.delete(id);
    for (const id of [...alertedOffline]) if (!seen.has(id)) alertedOffline.delete(id);
  }

  function prAlert(kind: AlertKind, what: string, p: Pick<PullRequest, 'id' | 'repo' | 'number' | 'title'>): Alert {
    return { key: `pr:${p.id}:${kind}`, kind, title: `${what}: ${p.repo} #${p.number}`, message: p.title };
  }

  function prAlerts(next: DashboardState, prev: DashboardState, out: Alert[]): void {
    const before = new Map(prev.prs.map((p) => [p.id, p]));
    for (const p of next.prs) {
      const o = before.get(p.id);
      if (!o) continue;
      if (p.checks.state === 'fail' && o.checks.state !== 'fail') out.push(prAlert('checks-failed', 'Checki nie przeszły', p));
      if (p.merge === 'ready' && o.merge !== 'ready') out.push(prAlert('ready', 'Gotowy do merge', p));
    }

    // What is already there at the first successful poll is old news.
    if (next.collectors.prs.lastSuccessAt === null) return;
    const first = !prsBaselined;
    prsBaselined = true;
    const need = next.prs.filter((p) => p.needsHuman);
    for (const p of need) {
      if (needingHuman.has(p.id)) continue;
      needingHuman.add(p.id);
      if (!first) out.push(prAlert('needs-human', 'Wymaga człowieka', p));
    }
    const ids = new Set(need.map((p) => p.id));
    for (const id of [...needingHuman]) if (!ids.has(id)) needingHuman.delete(id);
    for (const m of next.merged) {
      if (seenMerged.has(m.id)) continue;
      seenMerged.add(m.id);
      if (!first) out.push(prAlert('merged', 'Zmergowany', m));
    }
  }

  return {
    evaluate(next, prev) {
      const all: Alert[] = [];
      runnerAlerts(next, prev, all);
      prAlerts(next, prev, all);
      const seen = new Set<string>();
      return all.filter((a) => !seen.has(a.key) && seen.add(a.key));
    },
  };
}
