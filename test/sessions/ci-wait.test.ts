import { describe, expect, it } from 'vitest';
import { applyHookEvent, sweep, type Sessions } from '../../src/sessions/machine.js';
import type { HookEvent } from '../../src/types.js';

const MIN = 60_000;
const ev = (hook_event_name: string, o: Partial<HookEvent> = {}): HookEvent => ({ session_id: 's', cwd: '/w/p', hook_event_name, ...o });
const shell = (command: string, status = 'running') => ({ id: 'b', type: 'shell', status, command });
const run = (...events: HookEvent[]) => events.reduce<Sessions>((s, e) => applyHookEvent(s, e, 1000), {}).s;
const stop = (command: string, last = 'Czekam na wynik w tle.') =>
  ev('Stop', { background_tasks: [shell(command)], last_assistant_message: last });

describe('Stop while a shell waits for a PR or CI', () => {
  it.each([
    ['bash scripts/wait-pr.sh 1336', 'czeka na PR #1336'],
    ['bash ~/.claude/bin/wait-pr.sh 1338 owner/repo', 'czeka na PR #1338'],
    ['cd "C:/x y" && bash scripts/wait-pr.sh 1339', 'czeka na PR #1339'],
    ['gh run watch 45872739258 -R o/r --exit-status', 'czeka na CI'],
    ['gh pr checks 5 --watch', 'czeka na PR #5'],
    ['until [ "$(gh pr view 7 --json state --jq .state)" = MERGED ]; do sleep 60; done', 'czeka na PR #7'],
  ])('%s is not waiting for the user', (command, detail) => {
    expect(run(stop(command))).toMatchObject({ state: 'working', detail, waitsFor: 'pr' });
  });
  it.each(['npm run dev', 'sleep 25', 'gh pr view 5', 'npm test -- --watch'])('%s leaves the answer ready', (command) => {
    expect(run(stop(command))).toMatchObject({ state: 'waiting', detail: 'odpowiedź gotowa' });
  });
  it('a finished wait leaves the answer ready', () => {
    const s = run(ev('Stop', { background_tasks: [shell('bash wait-pr.sh 1', 'completed')] }));
    expect(s.state).toBe('waiting');
  });
  it('counts two waits', () => {
    const s = run(ev('Stop', { background_tasks: [shell('bash wait-pr.sh 1'), shell('bash wait-pr.sh 2')] }));
    expect(s.detail).toBe('czeka na PR (2)');
  });
  it.each(['PR czeka.\n\nKtóre teksty przyjmujesz? Przyjęte dodam później.', 'Wybierasz A czy B?', '**Otworzyć PR?**'])(
    'a question in the last paragraph waits for the user: %s', (last) => {
      expect(run(stop('bash wait-pr.sh 1', last))).toMatchObject({ state: 'waiting', detail: 'odpowiedź gotowa' });
    });
  it.each(['Czemu padło? Zła ścieżka.\n\nCzekam na bramkę.', 'Czekam: https://github.com/o/r/pull/1?tab=checks', 'Filtr `a?b` działa. Czekam.'])(
    'other question marks do not count: %s', (last) => {
      expect(run(stop('bash wait-pr.sh 1', last)).waitsFor).toBe('pr');
    });
  it('a question asked in the next-step box waits for the user until the next prompt', () => {
    const asked = ev('PreToolUse', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { ask: 'Otworzyć PR?', recap: 'r' } });
    expect(run(asked, stop('bash wait-pr.sh 1')).state).toBe('waiting');
    expect(run(asked, ev('UserPromptSubmit', { prompt: 'tak' }), stop('bash wait-pr.sh 1')).waitsFor).toBe('pr');
    const recapOnly = ev('PreToolUse', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'r' } });
    expect(run(recapOnly, stop('bash wait-pr.sh 1')).waitsFor).toBe('pr');
  });
  it.each([
    stop('bash wait-pr.sh 1'),
    ev('Stop', { background_tasks: [{ type: 'subagent', status: 'running' }] }),
  ])('the idle notification does not turn a background wait into waiting', (wait) => {
    const idle = ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
    expect(run(wait, idle).state).toBe('working');
  });
  it('a permission request still waits for the user, and a new prompt ends the PR wait', () => {
    expect(run(stop('bash wait-pr.sh 1'), ev('PermissionRequest', { tool_name: 'Bash' })).state).toBe('waiting');
    expect(run(stop('bash wait-pr.sh 1'), ev('UserPromptSubmit', { prompt: '<task-notification>x</task-notification>' })).waitsFor).toBeUndefined();
  });
  it('goes unknown only after 3 hours', () => {
    const sessions = applyHookEvent({}, stop('bash wait-pr.sh 1'), 0);
    expect(sweep(sessions, 179 * MIN).s.state).toBe('working');
    expect(sweep(sessions, 181 * MIN).s.state).toBe('unknown');
  });
});