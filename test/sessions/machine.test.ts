import { describe, it, expect } from 'vitest';
import { applyHookEvent, sweep, projectFromCwd, taskFromPrompt, type Sessions } from '../../src/sessions/machine.js';
import type { HookEvent } from '../../src/types.js';

const T0 = 1_000_000;
const ev = (e: Partial<HookEvent> & { hook_event_name: string }): HookEvent =>
  ({ session_id: 's1', cwd: '/home/u/proj', ...e });
const one = (e: Partial<HookEvent> & { hook_event_name: string }, now = T0, base: Sessions = {}) =>
  applyHookEvent(base, ev(e), now).s1;

describe('applyHookEvent table', () => {
  it('SessionStart -> waiting / nowa sesja', () => {
    const s = one({ hook_event_name: 'SessionStart' });
    expect(s).toMatchObject({ state: 'waiting', detail: 'nowa sesja', project: 'proj', cwd: '/home/u/proj', task: '', where: 'lokalna', since: T0, lastEventAt: T0 });
  });
  it('UserPromptSubmit -> working / myśli and sets task', () => {
    const s = one({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix bug\nmore' });
    expect(s).toMatchObject({ state: 'working', detail: 'myśli', task: 'Fix bug' });
  });
  it('PreToolUse -> working / tool name', () => {
    expect(one({ hook_event_name: 'PreToolUse', tool_name: 'Bash' })).toMatchObject({ state: 'working', detail: 'Bash' });
  });
  it('PreToolUse without tool -> narzędzie', () => {
    expect(one({ hook_event_name: 'PreToolUse' }).detail).toBe('narzędzie');
  });
  it('PostToolUse -> working / tool name', () => {
    expect(one({ hook_event_name: 'PostToolUse', tool_name: 'Edit' })).toMatchObject({ state: 'working', detail: 'Edit' });
  });
  it('PostToolUse without tool -> narzędzie', () => {
    expect(one({ hook_event_name: 'PostToolUse' }).detail).toBe('narzędzie');
  });
  it('PermissionRequest -> waiting / prośba o zgodę', () => {
    expect(one({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' })).toMatchObject({ state: 'waiting', detail: 'prośba o zgodę: Bash' });
  });
  it('Notification permission_prompt with tool_name', () => {
    expect(one({ hook_event_name: 'Notification', notification_type: 'permission_prompt', tool_name: 'Edit' })).toMatchObject({ state: 'waiting', detail: 'prośba o zgodę: Edit' });
  });
  it('Notification permission message extracts tool after "use "', () => {
    const s = one({ hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    expect(s).toMatchObject({ state: 'waiting', detail: 'prośba o zgodę: Bash' });
  });
  it('Notification permission without tool -> narzędzie', () => {
    expect(one({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }).detail).toBe('prośba o zgodę: narzędzie');
  });
  it('Notification idle_prompt -> waiting / czeka na odpowiedź', () => {
    expect(one({ hook_event_name: 'Notification', notification_type: 'idle_prompt' })).toMatchObject({ state: 'waiting', detail: 'czeka na odpowiedź' });
  });
  it('Notification "waiting for your input" message', () => {
    expect(one({ hook_event_name: 'Notification', message: 'Claude is waiting for your input' })).toMatchObject({ state: 'waiting', detail: 'czeka na odpowiedź' });
  });
  it('Notification other keeps state/detail, updates lastEventAt', () => {
    const base = applyHookEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }), T0);
    const s = applyHookEvent(base, ev({ hook_event_name: 'Notification', message: 'hello' }), T0 + 5).s1;
    expect(s).toMatchObject({ state: 'working', detail: 'Bash', since: T0, lastEventAt: T0 + 5 });
  });
  it('Stop -> waiting / odpowiedź gotowa', () => {
    expect(one({ hook_event_name: 'Stop' })).toMatchObject({ state: 'waiting', detail: 'odpowiedź gotowa' });
  });
  it('SessionEnd deletes session', () => {
    const base = applyHookEvent({}, ev({ hook_event_name: 'SessionStart' }), T0);
    const next = applyHookEvent(base, ev({ hook_event_name: 'SessionEnd' }), T0 + 1);
    expect(next).toEqual({});
  });
  it('unknown event on new id creates working/aktywna', () => {
    expect(one({ hook_event_name: 'Weird' })).toMatchObject({ state: 'working', detail: 'aktywna' });
  });
  it('unknown event on existing session keeps state/detail', () => {
    const base = applyHookEvent({}, ev({ hook_event_name: 'Stop' }), T0);
    const s = applyHookEvent(base, ev({ hook_event_name: 'Weird' }), T0 + 9).s1;
    expect(s).toMatchObject({ state: 'waiting', detail: 'odpowiedź gotowa', since: T0, lastEventAt: T0 + 9 });
  });
});

describe('applyHookEvent invariants', () => {
  it('empty or missing session_id returns same object', () => {
    const base: Sessions = {};
    expect(applyHookEvent(base, ev({ hook_event_name: 'Stop', session_id: '' }), T0)).toBe(base);
    expect(applyHookEvent(base, { hook_event_name: 'Stop' } as unknown as HookEvent, T0)).toBe(base);
  });
  it('does not mutate input', () => {
    const base = applyHookEvent({}, ev({ hook_event_name: 'SessionStart' }), T0);
    const copy = structuredClone(base);
    applyHookEvent(base, ev({ hook_event_name: 'Stop' }), T0 + 1);
    applyHookEvent(base, ev({ hook_event_name: 'SessionEnd' }), T0 + 1);
    expect(base).toEqual(copy);
  });
  it('missing cwd does not crash', () => {
    const s = applyHookEvent({}, { hook_event_name: 'Stop', session_id: 'x' }, T0).x;
    expect(s).toMatchObject({ project: '(nieznany)', cwd: '' });
  });
  it('other sessions unaffected', () => {
    const base = applyHookEvent({}, { hook_event_name: 'Stop', session_id: 'a' }, T0);
    const next = applyHookEvent(base, { hook_event_name: 'PreToolUse', session_id: 'b' }, T0 + 1);
    expect(next.a).toBe(base.a);
  });
  it('since unchanged on PreToolUse -> PostToolUse, changed on working -> waiting', () => {
    let s = applyHookEvent({}, ev({ hook_event_name: 'PreToolUse', tool_name: 'A' }), T0);
    s = applyHookEvent(s, ev({ hook_event_name: 'PostToolUse', tool_name: 'B' }), T0 + 10);
    expect(s.s1).toMatchObject({ since: T0, detail: 'B', lastEventAt: T0 + 10 });
    s = applyHookEvent(s, ev({ hook_event_name: 'Stop' }), T0 + 20);
    expect(s.s1.since).toBe(T0 + 20);
  });
  it('task set by first prompt only', () => {
    let s = applyHookEvent({}, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'first' }), T0);
    s = applyHookEvent(s, ev({ hook_event_name: 'UserPromptSubmit', prompt: 'second' }), T0 + 1);
    expect(s.s1.task).toBe('first');
  });
  it('dd_where chmura -> chmura', () => {
    expect(one({ hook_event_name: 'Stop', dd_where: 'chmura' }).where).toBe('chmura');
  });
});

describe('projectFromCwd / taskFromPrompt', () => {
  it('handles separators', () => {
    expect(projectFromCwd('C:\\code\\Toviq\\')).toBe('Toviq');
    expect(projectFromCwd('/home/u/dev-dashboard')).toBe('dev-dashboard');
    expect(projectFromCwd(undefined)).toBe('(nieznany)');
    expect(projectFromCwd('')).toBe('(nieznany)');
  });
  it('task: first non-empty line, trimmed', () => {
    expect(taskFromPrompt('\n  Fix the login bug\nmore')).toBe('Fix the login bug');
    expect(taskFromPrompt(undefined)).toBe('');
    expect(taskFromPrompt('  \n ')).toBe('');
  });
  it('task: 80 chars cut to 60 ending with ellipsis', () => {
    const t = taskFromPrompt('x'.repeat(80));
    expect(t).toHaveLength(60);
    expect(t.endsWith('…')).toBe(true);
    expect(taskFromPrompt('y'.repeat(60))).toBe('y'.repeat(60));
  });
});

describe('sweep', () => {
  const mk = (state: 'working' | 'waiting', lastEventAt: number): Sessions => ({
    a: { id: 'a', project: 'p', cwd: '', task: '', where: 'lokalna', state, detail: 'd', since: lastEventAt, lastEventAt },
  });
  const MIN = 60_000;
  it('working at 29:59 stays', () => {
    const s = mk('working', 0);
    expect(sweep(s, 30 * MIN - 1)).toBe(s);
  });
  it('working at 30:00 becomes unknown', () => {
    const r = sweep(mk('working', 0), 30 * MIN);
    expect(r.a).toMatchObject({ state: 'unknown', detail: 'brak zdarzeń', since: 30 * MIN });
  });
  it('waiting at 11 h stays', () => {
    const s = mk('waiting', 0);
    expect(sweep(s, 11 * 60 * MIN)).toBe(s);
  });
  it('any state at 12 h removed', () => {
    expect(sweep(mk('waiting', 0), 12 * 60 * MIN)).toEqual({});
    expect(sweep(mk('working', 0), 12 * 60 * MIN)).toEqual({});
  });
  it('unknown session at 12 h removed', () => {
    const u = sweep(mk('working', 0), 30 * MIN);
    expect(sweep(u, 12 * 60 * MIN)).toEqual({});
  });
  it('no change returns same reference', () => {
    const s = mk('working', 100);
    expect(sweep(s, 200)).toBe(s);
  });
  it('does not mutate input', () => {
    const s = mk('working', 0);
    const copy = structuredClone(s);
    sweep(s, 30 * MIN);
    expect(s).toEqual(copy);
  });
});

describe('background work and subagents', () => {
  const stopWith = (tasks: { type: string; status: string }[], base: Sessions = {}, now = T0) =>
    applyHookEvent(base, ev({ hook_event_name: 'Stop', background_tasks: tasks }), now);
  const sub = { type: 'subagent', status: 'running' };

  it('Stop with a running subagent stays working', () => {
    expect(stopWith([sub]).s1).toMatchObject({ state: 'working', detail: 'czeka na subagenta' });
  });
  it('Stop with several running subagents/workflows shows the count', () => {
    expect(stopWith([sub, { type: 'workflow', status: 'running' }]).s1.detail).toBe('czeka na subagentów (2)');
  });
  it('Stop with only a background shell is a ready answer', () => {
    expect(stopWith([{ type: 'shell', status: 'running' }]).s1).toMatchObject({ state: 'waiting', detail: 'odpowiedź gotowa' });
  });
  it('Stop with a finished subagent is a ready answer', () => {
    expect(stopWith([{ type: 'subagent', status: 'completed' }]).s1.state).toBe('waiting');
  });
  it('Stop with malformed background_tasks is a ready answer', () => {
    const s = applyHookEvent({}, ev({ hook_event_name: 'Stop', background_tasks: [null, 5] as never }), T0).s1;
    expect(s.state).toBe('waiting');
  });

  const asked = (agent_id?: string) =>
    applyHookEvent({}, ev({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', agent_id }), T0);

  it('another subagent tool event keeps the permission wait', () => {
    const s = applyHookEvent(asked(), ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'x' }), T0 + 5).s1;
    expect(s).toMatchObject({ state: 'waiting', detail: 'prośba o zgodę: Bash', since: T0, lastEventAt: T0 + 5 });
  });
  it('tool event from the asking agent clears the permission wait', () => {
    const s = applyHookEvent(asked('x'), ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'x' }), T0 + 5).s1;
    expect(s.state).toBe('working');
  });
  it('PostToolUse of the asked tool clears the wait even if the request had no agent_id', () => {
    const s = applyHookEvent(asked(), ev({ hook_event_name: 'PostToolUse', tool_name: 'Bash', agent_id: 'x' }), T0 + 5).s1;
    expect(s.state).toBe('working');
  });
  it('Notification without agent_id keeps the asking agent', () => {
    let s = applyHookEvent(asked('x'), ev({ hook_event_name: 'Notification', notification_type: 'permission_prompt' }), T0 + 1);
    s = applyHookEvent(s, ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'x' }), T0 + 5);
    expect(s.s1.state).toBe('working');
  });
  it('Stop with a running subagent keeps a pending permission wait', () => {
    const s = stopWith([sub], asked('x'), T0 + 5).s1;
    expect(s).toMatchObject({ state: 'waiting', detail: 'prośba o zgodę: Bash' });
  });
  it('after the permission wait ends, subagent events apply again', () => {
    let s = applyHookEvent(asked(), ev({ hook_event_name: 'UserPromptSubmit', prompt: 'ok' }), T0 + 1);
    s = applyHookEvent(s, ev({ hook_event_name: 'PreToolUse', tool_name: 'Read', agent_id: 'x' }), T0 + 5);
    expect(s.s1).toMatchObject({ state: 'working', detail: 'Read' });
  });
});

describe('taskFromPrompt ignores system messages', () => {
  it('skips a system-reminder block and uses the text after it', () => {
    expect(taskFromPrompt('<system-reminder>\nrules\n</system-reminder>\nFix login')).toBe('Fix login');
    expect(taskFromPrompt('<system-reminder id="1">r</system-reminder id="1">\n\nFix it')).toBe('Fix it');
  });
  it('gives no task for agent messages and notifications', () => {
    expect(taskFromPrompt('<agent-message from="a1">\nreport\n</agent-message>\nThat other session is an agent')).toBe('');
    expect(taskFromPrompt('<task-notification>\n<task-id>1</task-id>\n</task-notification>')).toBe('');
    expect(taskFromPrompt('Another text\n<agent-message from="a1">x</agent-message>')).toBe('Another text');
  });
  it('gives no task for an unclosed system tag', () => {
    expect(taskFromPrompt('<system-reminder>\ntruncated')).toBe('');
  });
  it('keeps ordinary markup in a user prompt', () => {
    expect(taskFromPrompt('<div> is broken')).toBe('<div> is broken');
  });
});