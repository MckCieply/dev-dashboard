import type { DashboardState } from '../types.js';

export interface Alert { key: string; title: string; message: string }

const OFFLINE_POLLS = 2;

export function createAlertEngine(): { evaluate(next: DashboardState, prev: DashboardState): Alert[] } {
  const streak = new Map<number, number>();
  const alertedOffline = new Set<number>();
  let baselined = false;
  let lastKeys = new Set<string>();

  function sessionAlerts(next: DashboardState, prev: DashboardState, out: Alert[]): void {
    const before = new Map(prev.sessions.map((s) => [s.id, s]));
    for (const s of next.sessions) {
      const p = before.get(s.id);
      if (!p || p.state === 'waiting' || s.state !== 'waiting') continue;
      out.push({
        key: `session:${s.id}:waiting:${s.since}`,
        title: `Czeka: ${s.project}`,
        message: s.task ? `${s.detail} · ${s.task}` : s.detail,
      });
    }
  }

  function runnerAlerts(next: DashboardState, prev: DashboardState, out: Alert[]): void {
    const stamp = next.collectors.runners.lastSuccessAt;
    if (stamp === null) return;
    if (!baselined) {
      baselined = true;
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
          out.push({ key: `runner:${r.id}:offline`, title: `Runner offline: ${r.name}`, message: r.os });
        }
      } else {
        streak.set(r.id, 0);
        if (alertedOffline.delete(r.id)) {
          out.push({ key: `runner:${r.id}:online`, title: `Runner znowu online: ${r.name}`, message: r.os });
        }
      }
    }
    for (const id of [...streak.keys()]) if (!seen.has(id)) streak.delete(id);
    for (const id of [...alertedOffline]) if (!seen.has(id)) alertedOffline.delete(id);
  }

  function prAlerts(next: DashboardState, prev: DashboardState, out: Alert[]): void {
    const before = new Map(prev.prs.map((p) => [p.id, p]));
    for (const p of next.prs) {
      const o = before.get(p.id);
      if (!o) continue;
      if (p.checks.state === 'fail' && o.checks.state !== 'fail') {
        out.push({ key: `pr:${p.id}:fail`, title: `Checki nie przeszły: ${p.repo} #${p.number}`, message: p.title });
      }
      if (p.merge === 'ready' && o.merge !== 'ready') {
        out.push({ key: `pr:${p.id}:ready`, title: `Gotowy do merge: ${p.repo} #${p.number}`, message: p.title });
      }
    }
  }

  return {
    evaluate(next, prev) {
      const all: Alert[] = [];
      sessionAlerts(next, prev, all);
      runnerAlerts(next, prev, all);
      prAlerts(next, prev, all);
      const out = all.filter((a) => !lastKeys.has(a.key));
      if (all.length > 0) lastKeys = new Set(all.map((a) => a.key));
      return out;
    },
  };
}
