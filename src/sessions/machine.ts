import type { HookEvent, Session, SessionState } from '../types.js';
import { PR_WAIT_UNKNOWN_AFTER_MS, REMOVE_AFTER_MS, UNKNOWN_AFTER_MS } from '../types.js';

export type Sessions = Record<string, Session>;

export function projectFromCwd(cwd: string | undefined): string {
  if (typeof cwd !== 'string') return '(nieznany)';
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '(nieznany)';
}

// Harness tags are hyphenated or underscored (system-reminder, agent-message, pasted_content).
const SYSTEM_BLOCK = /^<([a-z]+(?:[-_][a-z]+)+)\b[^>]*>[\s\S]*?<\/\1\b[^>]*>/;
export const SYSTEM_TAG = /^<[a-z]+(?:[-_][a-z]+)+\b/;
// A prompt that opens with one of these was not typed by the user.
const MACHINE_PROMPT = /^<(?:agent-message|task-notification)\b/;

function userText(prompt: string): string {
  let rest = prompt.trimStart();
  for (let m = SYSTEM_BLOCK.exec(rest); m; m = SYSTEM_BLOCK.exec(rest)) {
    if (MACHINE_PROMPT.test(rest)) return '';
    rest = rest.slice(m[0].length).trimStart();
  }
  return SYSTEM_TAG.test(rest) ? '' : rest;
}

// Background work after which Claude Code resumes the session on its own.
// Of the background shells only PR and CI waits count: a dev server would hide "answer ready" forever.
const RESUMING_TASKS = new Set(['subagent', 'workflow']);
const DONE_STATUS = new Set(['completed', 'failed', 'killed', 'stopped', 'cancelled']);

function pendingTasks(tasks: unknown): number {
  if (!Array.isArray(tasks)) return 0;
  return tasks.filter((t) => RESUMING_TASKS.has(t?.type) && !DONE_STATUS.has(t?.status)).length;
}

const CI_WAIT = [
  /\bwait-pr(\.sh)?\b/,
  /\bgh\s+run\s+watch\b/,
  /\bgh\s+pr\s+checks\b[^;&|\n]*--watch\b/,
  /^(?=[\s\S]*\bsleep\b)(?=[\s\S]*\b(?:until|while)\b)[\s\S]*\bgh\s+(?:pr|run|api)\b/,
];
const PR_NUMBER = /(?:\bwait-pr(?:\.sh)?["']?|\bgh\s+pr\s+(?:view|checks))\s+["']?(\d+)/;

/** Detail text when background shells wait for a PR or CI, else null. */
function ciWait(tasks: unknown): string | null {
  if (!Array.isArray(tasks)) return null;
  const waits: string[] = tasks
    .filter((t) => t?.type === 'shell' && !DONE_STATUS.has(t.status) && typeof t.command === 'string')
    .map((t) => t.command as string)
    .filter((c) => CI_WAIT.some((re) => re.test(c)));
  if (waits.length === 0) return null;
  if (waits.length > 1) return `czeka na PR (${waits.length})`;
  const n = PR_NUMBER.exec(waits[0])?.[1];
  return n ? `czeka na PR #${n}` : 'czeka na CI';
}

// A question mark that ends a word in the last paragraph; code and URLs do not count.
function asksUser(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  const last = message.trim().split(/\n\s*\n/).pop() ?? '';
  return /\?(?=$|[\s*_"”)\]])/.test(last.replace(/`[^`]*`|https?:\/\/\S+/g, ''));
}

export function taskFromPrompt(prompt: string | undefined): string {
  if (typeof prompt !== 'string') return '';
  const line = userText(prompt).split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '');
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

  const agent = str(ev.agent_id) ?? '';
  const ask = (asked: string): void => {
    state = 'waiting';
    detail = `prośba o zgodę: ${asked}`;
    delete s.waitsFor;
    // The follow-up Notification carries no agent_id: keep the first asker.
    s.permission = { agent: agent || (s.permission?.agent ?? ''), tool: asked };
  };
  const set = (next: SessionState, text: string): void => {
    state = next; detail = text; delete s.permission; delete s.waitsFor;
  };

  switch (name) {
    case 'SessionStart':
      set('waiting', 'nowa sesja'); break;
    case 'UserPromptSubmit':
      set('working', 'myśli');
      delete s.asked;
      if (s.task === '') s.task = taskFromPrompt(ev.prompt);
      break;
    case 'PreToolUse':
    case 'PostToolUse': {
      if (tool?.endsWith('__wrap_up') && !agent && str(ev.tool_input?.ask)) s.asked = true;
      const open = s.permission;
      // Parallel subagents keep running while one request waits for the user.
      const answered = !open || agent === open.agent || (name === 'PostToolUse' && tool === open.tool);
      if (answered) set('working', tool ?? 'narzędzie');
      break;
    }
    case 'PermissionRequest':
      ask(tool ?? 'narzędzie'); break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt' || /permission/i.test(message)) {
        const m = /\buse\s+(\S+)/i.exec(message);
        ask(tool ?? m?.[1] ?? s.permission?.tool ?? 'narzędzie');
      } else if (!s.waitsFor && (ev.notification_type === 'idle_prompt' || /waiting for your input/i.test(message))) {
        set('waiting', 'czeka na odpowiedź');
      }
      break;
    case 'Stop': {
      const pending = pendingTasks(ev.background_tasks);
      const pr = ciWait(ev.background_tasks);
      if (pending > 0) {
        if (!s.permission) {
          set('working', pending === 1 ? 'czeka na subagenta' : `czeka na subagentów (${pending})`);
          s.waitsFor = 'subagent';
        }
      } else if (pr && !s.asked && !asksUser(ev.last_assistant_message)) {
        if (!s.permission) { set('working', pr); s.waitsFor = 'pr'; }
      } else set('waiting', 'odpowiedź gotowa');
      break;
    }
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
    } else if (s.state === 'working' && age >= (s.waitsFor === 'pr' ? PR_WAIT_UNKNOWN_AFTER_MS : UNKNOWN_AFTER_MS)) {
      out ??= { ...sessions };
      const { waitsFor: _gone, ...rest } = s;
      out[id] = { ...rest, state: 'unknown', detail: 'brak zdarzeń', since: now };
    }
  }
  return out ?? sessions;
}
