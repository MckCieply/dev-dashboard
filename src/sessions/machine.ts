import type { HookEvent, Session, SessionState } from '../types.js';
import { REMOVE_AFTER_MS, UNKNOWN_AFTER_MS } from '../types.js';

export type Sessions = Record<string, Session>;

export function projectFromCwd(cwd: string | undefined): string {
  if (typeof cwd !== 'string') return '(nieznany)';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(nieznany)';
}

export function taskFromPrompt(prompt: string | undefined): string {
  if (typeof prompt !== 'string') return '';
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
  if (!line) return '';
  return line.length > 60 ? line.slice(0, 59) + '…' : line;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

export function applyHookEvent(sessions: Sessions, ev: HookEvent, now: number): Sessions {
  const id = str(ev?.session_id);
  if (!id) return sessions;
  const name = ev.hook_event_name;

  if (name === 'SessionEnd') {
    if (!(id in sessions)) return sessions;
    const { [id]: _removed, ...rest } = sessions;
    return rest;
  }

  const cwd = str(ev.cwd);
  const existing = sessions[id];
  const s: Session = existing
    ? { ...existing }
    : {
        id, project: projectFromCwd(cwd), cwd: cwd ?? '', task: '',
        where: ev.dd_where === 'chmura' ? 'chmura' : 'lokalna',
        state: 'working', detail: 'aktywna', since: now, lastEventAt: now,
      };

  const tool = str(ev.tool_name);
  const message = typeof ev.message === 'string' ? ev.message : '';
  let state: SessionState = s.state;
  let detail = s.detail;

  switch (name) {
    case 'SessionStart':
      state = 'waiting'; detail = 'nowa sesja'; break;
    case 'UserPromptSubmit':
      state = 'working'; detail = 'myśli';
      if (s.task === '') s.task = taskFromPrompt(ev.prompt);
      break;
    case 'PreToolUse':
    case 'PostToolUse':
      state = 'working'; detail = tool ?? 'narzędzie'; break;
    case 'PermissionRequest':
      state = 'waiting'; detail = `prośba o zgodę: ${tool ?? 'narzędzie'}`; break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt' || /permission/i.test(message)) {
        const m = /\buse\s+(\S+)/i.exec(message);
        state = 'waiting';
        detail = `prośba o zgodę: ${tool ?? m?.[1] ?? 'narzędzie'}`;
      } else if (ev.notification_type === 'idle_prompt' || /waiting for your input/i.test(message)) {
        state = 'waiting'; detail = 'czeka na odpowiedź';
      }
      break;
    case 'Stop':
      state = 'waiting'; detail = 'odpowiedź gotowa'; break;
    default:
      break;
  }

  if (state !== s.state) s.since = now;
  s.state = state;
  s.detail = detail;
  s.lastEventAt = now;
  return { ...sessions, [id]: s };
}

export function sweep(sessions: Sessions, now: number): Sessions {
  let out: Sessions | null = null;
  for (const [id, s] of Object.entries(sessions)) {
    const age = now - s.lastEventAt;
    if (age >= REMOVE_AFTER_MS) {
      out ??= { ...sessions };
      delete out[id];
    } else if (s.state === 'working' && age >= UNKNOWN_AFTER_MS) {
      out ??= { ...sessions };
      out[id] = { ...s, state: 'unknown', detail: 'brak zdarzeń', since: now };
    }
  }
  return out ?? sessions;
}
