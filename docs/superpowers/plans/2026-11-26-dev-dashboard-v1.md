# Dev dashboard v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local Node service plus page at `http://localhost:4317` that shows Claude Code sessions (working/waiting), self-hosted runners, the Actions queue and open PRs, and fires Windows toasts on state changes.

**Architecture:** One Node process. Pure modules (session state machine, GitHub mappers, alert rules, HTML render functions) hold all logic and are unit-tested. Thin shells (HTTP server, GitHub poller, toast sender, hook script) wire them together. The browser gets the full state over Server-Sent Events.

**Tech Stack:** Node >= 20 (built-in `fetch`, `node:http`), TypeScript (ESM, run with `tsx`), vitest, `node-notifier`, `@fontsource/jetbrains-mono`, `@fontsource/inter`. No web framework, no frontend framework, no bundler.

**Spec:** `docs/superpowers/specs/2026-11-26-dev-dashboard-design.md`. Visual rules: `.claude/DESIGN_DIRECTION.md` (LOCKED). Mockup: `design/telemetria-mockup.dc.html`.

## Global Constraints

- HTTP server binds `127.0.0.1`, default port `4317` (env `DEV_DASHBOARD_PORT` overrides).
- Hook script: fire-and-forget POST, 2 s timeout, always exit code 0, never prints to stdout.
- Session rules: working with no event 30 min becomes `unknown`; no event 12 h in any state is removed; `SessionEnd` removes.
- Session id = `session_id`; project = last segment of `cwd`; task = first line of first prompt, max 60 chars.
- Active repo = `pushed_at` within the last 14 days, not archived; repo list refresh every 10 min.
- GitHub poll every 30 s with ETags; when `x-ratelimit-remaining` < 500, poll every 120 s and show a footer note.
- Token: `gh auth token`, else env `GITHUB_TOKEN`, else env `GH_TOKEN`.
- Runner offline toast only after 2 consecutive offline polls. Toast once per transition. No toasts for state that existed at startup. No toast for `SessionStart`.
- One collector failing never blanks another panel. Error line text format: `GitHub: błąd 401, dane z 14:32`.
- UI text in Polish. Code, comments, commits, README in English.
- Visual: follow `.claude/DESIGN_DIRECTION.md` exactly. Radius 0, colors only from its token table, every status = icon + `[LABEL]`, fonts self-hosted (no request to Google Fonts).
- Session persistence file: `<dataDir>/sessions.json`; `dataDir` = env `DEV_DASHBOARD_DATA_DIR`, else `%LOCALAPPDATA%\dev-dashboard` on Windows, else `~/.local/state/dev-dashboard`.
- All time values inside the app are epoch milliseconds (`number`).

## Review Focus

1. A hook payload with missing or unexpected fields (no `cwd`, unknown `hook_event_name`, malformed JSON) must not crash the server or change other sessions. Test in Task 1 (machine) and Task 2 (HTTP 400 on bad JSON).
2. Service restart while sessions are waiting: restored sessions must not re-toast. Test in Task 6 (`createAlertEngine` baseline).
3. GitHub returns 401/403/404 for one repo's runners (no admin rights): the other repos' runners still show and the collector reports a readable error. Test in Task 5 (poller with fake client).
4. Text from sessions/PR titles containing `<script>` or `&` must render escaped. Test in Task 7 (render).
5. Machine sleeps for hours, then wakes: the sweep moves working sessions to `unknown` or removes them in one pass, no burst of toasts. Test in Task 1 (sweep) and Task 6 (no alert for transitions to `unknown`).

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
src/
  types.ts                 shared types (Task 1)
  config.ts                loadConfig() (Task 1)
  sessions/machine.ts      pure session reducer + sweep (Task 1)
  sessions/persist.ts      load/save sessions JSON (Task 2)
  store.ts                 Store: state + change listeners (Task 2)
  server/http.ts           routes, SSE, static files (Task 2)
  github/client.ts         GitHubClient: REST w/ ETag, GraphQL, rate info, token (Task 4)
  github/repos.ts          filterActiveRepos (Task 4)
  github/runners.ts        mapRunners (Task 5)
  github/queue.ts          mapRuns (Task 5)
  github/prs.ts            buildPrQuery, mapPrs (Task 5)
  github/poller.ts         GitHubPoller (Task 5)
  notify/rules.ts          createAlertEngine (pure) (Task 6)
  notify/toast.ts          sendToast via node-notifier (Task 6)
  main.ts                  wiring (Task 8)
hooks/report.mjs           Claude Code hook script (Task 3)
scripts/install-hooks.mjs  adds/removes hook entries in ~/.claude/settings.json (Task 3)
public/index.html, public/style.css, public/app.js, public/render.js, public/icons.js (Task 7)
test/**                    vitest tests + fixtures
```

---

### Task 1: Scaffold, shared types, config, session state machine

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/config.ts`, `src/sessions/machine.ts`
- Test: `test/sessions/machine.test.ts`, `test/config.test.ts`

**Interfaces — Produces (exact, later tasks import these):**

`src/types.ts`:
```ts
export type Where = 'lokalna' | 'chmura';
export type SessionState = 'working' | 'waiting' | 'unknown';
export interface Session {
  id: string; project: string; cwd: string; task: string; where: Where;
  state: SessionState; detail: string; since: number; lastEventAt: number;
}
export interface HookEvent {
  hook_event_name: string; session_id: string; cwd?: string; prompt?: string;
  tool_name?: string; message?: string; notification_type?: string;
  dd_where?: Where; // added by hooks/report.mjs
}
export type RunnerState = 'busy' | 'idle' | 'offline';
export interface RunnerJob { repo: string; workflow: string; runNumber: number; startedAt: number }
export interface Runner { id: number; name: string; os: string; labels: string[]; state: RunnerState; job: RunnerJob | null }
export type RunState = 'queued' | 'in_progress';
export interface QueuedRun {
  id: number; repo: string; workflow: string; runNumber: number; branch: string; state: RunState;
  createdAt: number; startedAt: number | null; labels: string[]; runnerName: string | null; url: string;
}
export type ChecksState = 'pass' | 'fail' | 'pending' | 'none';
export type ReviewState = 'approved' | 'changes_requested' | 'review_required' | 'draft' | 'none';
export type MergeState = 'ready' | 'blocked' | 'conflict' | 'draft' | 'unknown';
export interface PullRequest {
  id: string; repo: string; number: number; title: string; url: string; draft: boolean;
  checks: { state: ChecksState; passed: number; failed: number; total: number };
  review: ReviewState; merge: MergeState;
}
export type CollectorName = 'sessions' | 'repos' | 'runners' | 'queue' | 'prs';
export interface CollectorStatus { ok: boolean; lastSuccessAt: number | null; error: string | null }
export interface RateInfo { remaining: number; limit: number; resetAt: number; slowed: boolean }
export interface DashboardState {
  sessions: Session[]; runners: Runner[]; queue: QueuedRun[]; prs: PullRequest[]; repos: string[];
  collectors: Record<CollectorName, CollectorStatus>; rate: RateInfo | null; toasts: boolean; now: number;
}
export const UNKNOWN_AFTER_MS = 30 * 60_000;
export const REMOVE_AFTER_MS = 12 * 60 * 60_000;
```

`src/config.ts`:
```ts
export interface Config { port: number; dataDir: string; toasts: boolean; activeDays: number; pollMs: number; slowPollMs: number; reposRefreshMs: number; orgs: string[] }
export function loadConfig(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, home?: string): Config
```
Defaults: port 4317, toasts true, activeDays 14, pollMs 30_000, slowPollMs 120_000, reposRefreshMs 600_000, orgs []. Env overrides: `DEV_DASHBOARD_PORT`, `DEV_DASHBOARD_DATA_DIR`, `DEV_DASHBOARD_TOASTS` (`0`/`false` disables), `DEV_DASHBOARD_ORGS` (comma list). dataDir per Global Constraints (Windows uses `env.LOCALAPPDATA`).

`src/sessions/machine.ts`:
```ts
export type Sessions = Record<string, Session>;
export function applyHookEvent(sessions: Sessions, ev: HookEvent, now: number): Sessions // returns NEW object, never mutates input
export function sweep(sessions: Sessions, now: number): Sessions                      // returns same object reference if nothing changed
export function projectFromCwd(cwd: string | undefined): string                       // handles / and \ separators, trailing separator; '' or undefined -> '(nieznany)'
export function taskFromPrompt(prompt: string | undefined): string                    // first non-empty line, trimmed, max 60 chars (cut to 59 + '…'); empty -> ''
```

Rules for `applyHookEvent` (session `s` = existing or created):
| `hook_event_name` | state | detail |
|---|---|---|
| `SessionStart` | waiting | `nowa sesja` |
| `UserPromptSubmit` | working | `myśli` ; if `s.task === ''` set `task = taskFromPrompt(prompt)` |
| `PreToolUse` | working | `tool_name` or `narzędzie` |
| `PostToolUse` | working | `tool_name` or `narzędzie` |
| `PermissionRequest` | waiting | `prośba o zgodę: <tool_name>` |
| `Notification` with `notification_type==='permission_prompt'` or `message` matching `/permission/i` | waiting | `prośba o zgodę: <tool>` where tool = `tool_name`, else the word after `use ` in message (`"Claude needs your permission to use Bash"` -> `Bash`), else `narzędzie` |
| `Notification` with `notification_type==='idle_prompt'` or `message` matching `/waiting for your input/i` | waiting | `czeka na odpowiedź` |
| `Notification` other | unchanged state/detail; only `lastEventAt` updates |
| `Stop` | waiting | `odpowiedź gotowa` |
| `SessionEnd` | session deleted |
| any other name | unchanged state/detail; only `lastEventAt` updates (session created if new, state `working`, detail `aktywna`) |

- Missing/empty `session_id` -> return input unchanged.
- New session defaults: `project = projectFromCwd(cwd)`, `cwd = cwd ?? ''`, `task = ''`, `where = ev.dd_where === 'chmura' ? 'chmura' : 'lokalna'`.
- `since` changes only when `state` changes (detail change alone keeps `since`). `lastEventAt = now` on every accepted event.
- `sweep`: delete if `now - lastEventAt >= REMOVE_AFTER_MS`; else if state `working` and `now - lastEventAt >= UNKNOWN_AFTER_MS` -> state `unknown`, detail `brak zdarzeń`, `since = now`.

- [ ] **Step 1: Scaffold**

`package.json`:
```json
{
  "name": "dev-dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "start": "tsx src/main.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "install-hooks": "node scripts/install-hooks.mjs",
    "uninstall-hooks": "node scripts/install-hooks.mjs --uninstall"
  }
}
```
Then run: `npm install tsx node-notifier @fontsource/jetbrains-mono @fontsource/inter` and `npm install -D typescript vitest @types/node @types/node-notifier`.

`tsconfig.json`: `target ES2022`, `module NodeNext`, `moduleResolution NodeNext`, `strict true`, `noEmit true`, `skipLibCheck true`, `allowJs true`, `checkJs false`, `include ["src","test","public","hooks","scripts"]`. Imports between TS files use `.js` suffix (`import { x } from './types.js'`).

`vitest.config.ts`: `test: { include: ['test/**/*.test.{ts,js,mjs}'], environment: 'node' }`.

Add `package-lock.json` to the commit. `.gitignore` already exists (keep `node_modules/`).

- [ ] **Step 2: Write failing tests** in `test/sessions/machine.test.ts`: one `it` per table row above, plus:
  - unknown event name on new id creates session `working`/`aktywna`;
  - empty `session_id` returns the same object;
  - input object not mutated (deep-freeze input with `structuredClone` + compare);
  - `since` unchanged on PreToolUse→PostToolUse, changed on working→waiting;
  - `task` set by first prompt only (second prompt does not overwrite);
  - `projectFromCwd('C:\\code\\Toviq\\')` → `Toviq`, `'/home/u/dev-dashboard'` → `dev-dashboard`, `undefined` → `(nieznany)`;
  - `taskFromPrompt('\n  Fix the login bug\nmore')` → `Fix the login bug`; 80-char line → 60 chars ending `…`;
  - `dd_where: 'chmura'` → `where: 'chmura'`;
  - sweep: working at 29:59 stays; at 30:00 becomes unknown/`brak zdarzeń`; waiting at 11 h stays waiting; any state at 12 h removed; sweep with no change returns same reference.
  `test/config.test.ts`: defaults; each env override; Windows dataDir uses `LOCALAPPDATA`; `DEV_DASHBOARD_TOASTS=0` → false.

- [ ] **Step 3:** Run `npx vitest run test/sessions test/config.test.ts` — expect FAIL (modules missing).
- [ ] **Step 4:** Implement `src/types.ts`, `src/config.ts`, `src/sessions/machine.ts`.
- [ ] **Step 5:** Run `npm test` and `npm run typecheck` — expect PASS.
- [ ] **Step 6: Teeth:** change `UNKNOWN_AFTER_MS` comparison `>=` to `>` and the PermissionRequest detail; confirm tests fail; restore.
- [ ] **Step 7: Commit** `feat: session state machine, types and config`.

---

### Task 2: Store, session persistence, HTTP server (hook endpoint, state API, SSE, static)

**Files:**
- Create: `src/store.ts`, `src/sessions/persist.ts`, `src/server/http.ts`
- Test: `test/store.test.ts`, `test/sessions/persist.test.ts`, `test/server/http.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `applyHookEvent`, `sweep`.
- Produces:
```ts
// src/store.ts
export type Listener = (next: DashboardState, prev: DashboardState) => void;
export class Store {
  constructor(init: { sessions?: Sessions; toasts: boolean; now?: () => number });
  get(): DashboardState;                       // fresh object with now = this.now()
  getSessions(): Sessions;
  onChange(fn: Listener): () => void;          // returns unsubscribe
  applyHook(ev: HookEvent): void;              // applies machine, sets collectors.sessions ok, emits if changed
  sweepSessions(): void;                       // emits only if sweep returned a new object
  setRepos(repos: string[]): void;
  setRunners(r: Runner[]): void; setQueue(q: QueuedRun[]): void; setPrs(p: PullRequest[]): void;
  setCollector(name: CollectorName, status: Partial<CollectorStatus>): void; // merges
  setRate(r: RateInfo | null): void;
}
// initial collectors: sessions {ok:true,lastSuccessAt:null,error:null}; others {ok:false,lastSuccessAt:null,error:null}
// Every setter emits exactly one change event (listeners get next, prev). Sessions array in DashboardState sorted: waiting first (oldest since first), then working, then unknown; ties by project.

// src/sessions/persist.ts
export function loadSessions(file: string): Sessions;            // missing file or bad JSON -> {} (bad JSON: log one warning to stderr)
export function createSessionSaver(file: string, delayMs?: number): { save(s: Sessions): void; flush(): void }; // debounce 1000 ms default; mkdir -p; write to file.tmp then rename

// src/server/http.ts
export function createServer(opts: { store: Store; publicDir: string; fontsDir: string }): import('node:http').Server;
```
Routes:
- `POST /hook` — body ≤ 1 MB, JSON object with string `session_id` → `store.applyHook`, respond `204`. Bad JSON / not an object → `400`. Over 1 MB → `413`.
- `GET /api/state` — `200` JSON `store.get()`.
- `GET /api/events` — SSE: headers `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`; on connect write `event: state\ndata: <json>\n\n`; on every store change write the same; every 25 s write `: ping\n\n`; unsubscribe on `close`.
- `GET /` → `publicDir/index.html`. `GET /<file>` → file from `publicDir` (types: `.html .css .js .svg .woff2 .json`). `GET /fonts/<pkg>/<path>` → from `fontsDir/@fontsource/<pkg>/<path>` where pkg ∈ {`jetbrains-mono`,`inter`}. Reject any path containing `..` after decoding → `404`. Unknown → `404`.
- Any other method/route → `404`.

- [ ] **Step 1: Failing tests**
  - store: applyHook emits once with next/prev; sorting rule; setCollector merges; sweepSessions with nothing stale emits nothing; `get().now` uses injected clock.
  - persist: round-trip; missing file → `{}`; corrupt file → `{}`; saver debounces (fake timers: 3 saves in 500 ms → 1 write); flush writes immediately.
  - http (start on port 0, use `fetch`): POST valid hook → 204 and `/api/state` shows session; POST `not json` → 400 and state unchanged; POST 1.1 MB → 413; SSE: connect, read first `event: state`, POST hook, read second event containing the session id; `GET /../package.json` and `GET /%2e%2e/package.json` → 404; `GET /` → 200 `text/html`; `GET /fonts/inter/900.css` → 200 (use real `node_modules`).
  For tests, `publicDir` = a temp dir with a stub `index.html` (Task 7 creates the real one).
- [ ] **Step 2:** Run tests — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test && npm run typecheck` — PASS.
- [ ] **Step 5: Teeth:** remove the `..` check → traversal test fails; remove the 400 branch → bad JSON test fails. Restore.
- [ ] **Step 6: Commit** `feat: store, session persistence and HTTP server`.

---

### Task 3: Hook script and hook installer

**Files:**
- Create: `hooks/report.mjs`, `scripts/install-hooks.mjs`
- Test: `test/hooks/report.test.mjs`, `test/hooks/install.test.mjs`

**Interfaces:**
- Consumes: `POST /hook` from Task 2 (contract only; tests use their own tiny server).
- Produces:
  - `hooks/report.mjs`: reads all stdin, parses JSON (on failure exit 0 silently), adds `dd_where: process.env.CLAUDE_CODE_REMOTE === 'true' ? 'chmura' : 'lokalna'`, POSTs to `process.env.DEV_DASHBOARD_URL ?? 'http://127.0.0.1:4317/hook'` with `AbortSignal.timeout(2000)`, swallows every error, `process.exit(0)`. Writes nothing to stdout or stderr.
  - `scripts/install-hooks.mjs` exports (for tests) and runs as CLI when executed directly:
```js
export const EVENTS = ['SessionStart','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','Notification','Stop','SessionEnd'];
export function hookCommand(reportPath) // -> `node "${reportPath}"` with forward slashes
export function addHooks(settings, reportPath)    // returns new settings object; idempotent; keeps all foreign entries
export function removeHooks(settings, reportPath) // removes only hook entries whose command includes reportPath (forward slashes); drops empty event arrays
```
  Entry shape per event: `{ matcher: '*', hooks: [{ type: 'command', command, timeout: 5 }] }` for `PreToolUse`, `PostToolUse`, `PermissionRequest`; `{ hooks: [{ type: 'command', command, timeout: 5 }] }` for the rest.
  CLI: settings path = `--settings <path>` or `~/.claude/settings.json`; missing file → start from `{}`. Prints a summary of events to add/remove, asks `Apply? [y/N]` unless `--yes`. Writes backup `settings.json.bak-<timestamp>` before writing. `--uninstall` uses `removeHooks`. Exits 1 with a message if the settings file is not valid JSON (never overwrite it).
  Our entries are recognised by the absolute report path (forward slashes) inside `command`, so a renamed repo folder still works.

- [ ] **Step 1: Failing tests**
  - report: spawn `node hooks/report.mjs` with stdin JSON and `DEV_DASHBOARD_URL` pointing at a test server on port 0 → server receives body with `dd_where:'lokalna'`; with `CLAUDE_CODE_REMOTE=true` → `'chmura'`; with URL to a closed port → exit 0 in < 3 s, empty stdout/stderr; with server that never responds → exit 0 in < 3 s; with invalid stdin → exit 0, no request.
  - install: `addHooks({}, p)` creates 8 events; calling twice gives identical result; foreign hooks in `Stop` kept; `removeHooks(addHooks(foreign, p), p)` deep-equals `foreign`; Windows path `C:\\x\\dev-dashboard\\hooks\\report.mjs` → command uses forward slashes; CLI with `--settings tmp --yes` writes file and backup; CLI on invalid JSON exits 1 and file unchanged.
- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement. **Step 4:** `npm test` — PASS.
- [ ] **Step 5: Teeth:** remove `process.exit(0)` in the catch path / remove timeout → hanging-server test fails. Restore.
- [ ] **Step 6: Commit** `feat: Claude Code hook script and installer`.

---

### Task 4: GitHub client and active-repo filter

**Files:**
- Create: `src/github/client.ts`, `src/github/repos.ts`
- Test: `test/github/client.test.ts`, `test/github/repos.test.ts`

**Interfaces:**
- Produces:
```ts
// src/github/client.ts
export class GitHubError extends Error { constructor(public status: number, message: string) }
export type FetchFn = typeof fetch;
export interface RateSnapshot { remaining: number; limit: number; resetAt: number } // resetAt epoch ms
export class GitHubClient {
  constructor(opts: { token: string; fetch?: FetchFn; baseUrl?: string /* default https://api.github.com */ });
  rest<T>(path: string): Promise<T>;            // GET; sends If-None-Match when cached ETag; 304 -> cached body; non-2xx -> GitHubError(status, `${status} ${statusText}`)
  graphql<T>(query: string): Promise<T>;       // POST /graphql; errors array -> GitHubError(200, first message); returns data
  lastRate(): RateSnapshot | null;             // from x-ratelimit-* headers of the latest response (REST or GraphQL)
}
export async function resolveToken(env?: NodeJS.ProcessEnv, run?: (cmd: string, args: string[]) => Promise<string>): Promise<string | null>
// tries `gh auth token` (trimmed, non-empty), then GITHUB_TOKEN, then GH_TOKEN; never throws
// headers on every request: Authorization: Bearer <token>, Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28, User-Agent: dev-dashboard

// src/github/repos.ts
export interface RawRepo { full_name: string; pushed_at: string | null; archived: boolean; owner: { login: string; type: string } }
export function filterActiveRepos(repos: RawRepo[], now: number, days: number): string[] // full_name list, newest push first; pushed_at null excluded; archived excluded; boundary: exactly `days` days old is included
export function orgsFromRepos(repos: RawRepo[]): string[] // unique owner.login where owner.type === 'Organization'
export const REPOS_PATH = '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member';
```
- [ ] **Step 1: Failing tests** with a fake `fetch` (records calls, returns `new Response(...)`):
  - first call no `If-None-Match`; response with `ETag: "abc"`; second call sends `If-None-Match: "abc"`, fake returns 304 → same body returned;
  - 401 → throws `GitHubError` with `status 401`;
  - rate headers parsed (`x-ratelimit-reset` is epoch seconds → ms);
  - graphql with `{errors:[{message:'x'}]}` → throws; with data → returns data;
  - `resolveToken`: gh succeeds → its token; gh throws → `GITHUB_TOKEN`; none → `null`;
  - repos: 14-day boundary (exactly 14 d included, 14 d + 1 ms excluded), archived excluded, null excluded, sort order; orgs unique.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npm test && npm run typecheck`).
- [ ] **Step 5: Teeth:** drop the 304 branch → ETag test fails. Restore.
- [ ] **Step 6: Commit** `feat: GitHub client with ETag cache and active repo filter`.

---

### Task 5: GitHub mappers (runners, queue, PRs) and poller

**Files:**
- Create: `src/github/runners.ts`, `src/github/queue.ts`, `src/github/prs.ts`, `src/github/poller.ts`
- Test: `test/github/runners.test.ts`, `test/github/queue.test.ts`, `test/github/prs.test.ts`, `test/github/poller.test.ts`, fixtures `test/fixtures/runners.json`, `runs-queued.json`, `runs-in-progress.json`, `jobs.json`, `prs-graphql.json` (shapes per GitHub REST docs: `{total_count, runners:[{id,name,os,status,busy,labels:[{name}]}]}`, `{total_count, workflow_runs:[{id,name,path,run_number,head_branch,status,created_at,run_started_at,html_url,repository:{full_name}}]}`, `{total_count, jobs:[{id,run_id,status,labels:[],runner_name,started_at}]}`).

**Interfaces:**
- Consumes: `GitHubClient`, `filterActiveRepos`, `orgsFromRepos`, `REPOS_PATH`, `Store` setters, types.
- Produces:
```ts
// runners.ts
export interface RawRunner { id: number; name: string; os: string; status: 'online' | 'offline'; busy: boolean; labels: { name: string }[] }
export function mapRunners(raw: RawRunner[], inProgress: QueuedRun[]): Runner[]
// state: offline if status offline; busy if busy; else idle. os: `${os} · ${archLabel}` where archLabel = first label in [X64, ARM64, ARM] else omitted ("Linux" alone).
// job: from inProgress run whose runnerName === runner.name (null if none). Dedupe by id. Sort: busy, idle, offline; then name.
// queue.ts
export interface RawRun { id: number; name: string | null; path: string; run_number: number; head_branch: string | null; status: string; created_at: string; run_started_at?: string | null; html_url: string; repository: { full_name: string } }
export interface RawJob { id: number; run_id: number; status: string; labels: string[]; runner_name: string | null; started_at: string | null }
export function mapRuns(runs: RawRun[], jobsByRun: Record<number, RawJob[]>): QueuedRun[]
// workflow = basename of path (".github/workflows/ci.yml" -> "ci.yml"); state from status ('queued'|'waiting'|'pending'|'requested' -> queued, 'in_progress' -> in_progress, others dropped);
// labels = union of labels of non-completed jobs, excluding 'self-hosted'; runnerName = first in_progress job's runner_name; startedAt = run_started_at for in_progress else null.
// sort: in_progress first, then queued oldest createdAt first.
// prs.ts
export function buildPrQuery(repos: string[]): string  // aliases r0..rN; repo owner/name are JSON.stringify'd (escaping); includes rateLimit { remaining limit resetAt }
export function mapPrs(data: unknown, repos: string[]): PullRequest[]
// checks/review/merge rules exactly as spec Part 2.5 + these: CheckRun conclusion SUCCESS|NEUTRAL|SKIPPED = passed; FAILURE|TIMED_OUT|CANCELLED|ACTION_REQUIRED|STARTUP_FAILURE = failed; StatusContext SUCCESS = passed, FAILURE|ERROR = failed; rest pending.
// rollup state: null -> none; SUCCESS -> pass; FAILURE|ERROR -> fail; else pending.
// review: isDraft -> draft; APPROVED/CHANGES_REQUESTED/REVIEW_REQUIRED mapped; null -> none.
// merge: isDraft -> draft; mergeable CONFLICTING -> conflict; mergeStateStatus CLEAN|HAS_HOOKS -> ready; BLOCKED|BEHIND|UNSTABLE|DIRTY -> blocked; else unknown.
// A repo alias that is null (no access) is skipped. Sort: fail first, then ready, then rest; within group by repo then number desc.
// poller.ts
export class GitHubPoller {
  constructor(opts: { client: GitHubClient | null; store: Store; config: Config; now?: () => number; log?: (msg: string) => void });
  refreshRepos(): Promise<void>;   // REPOS_PATH -> store.setRepos + collector 'repos'
  pollOnce(): Promise<void>;       // runs, runners, prs collectors; each in its own try/catch
  start(): void; stop(): void;     // timers: repos every reposRefreshMs; poll every pollMs, or slowPollMs while rate.remaining < 500
}
```
Poller rules:
- `client === null` → every GitHub collector gets `{ok:false, error:'brak tokenu GitHub'}` and no requests are made.
- queue collector: for each repo `GET /repos/{r}/actions/runs?status=queued&per_page=50` and `?status=in_progress&per_page=50`, then jobs `GET /repos/{r}/actions/runs/{id}/jobs?per_page=50` for each run. Runs on repos run before runners (runners need in-progress runs).
- runners collector: `GET /repos/{r}/actions/runners?per_page=100` per repo, plus `GET /orgs/{org}/actions/runners?per_page=100` for `config.orgs ∪ orgsFromRepos`. Per-repo 403/404 is ignored (repo without admin rights); collector error only if every request failed, message `błąd <status>`. Other statuses → error for collector but keep successful results.
- prs collector: one `graphql(buildPrQuery(repos))` (skip if no repos → empty list, ok).
- On success: `setCollector(name, {ok:true, lastSuccessAt: now, error:null})`. On failure: `{ok:false, error: 'błąd <status>'}` (or `błąd sieci` for non-GitHubError), data left as is (stale).
- After each poll: `store.setRate({...client.lastRate(), slowed: remaining < 500})`.
- `start()` calls `refreshRepos()` then `pollOnce()` immediately; uses `setTimeout` chains (no overlapping polls).

- [ ] **Step 1: Failing tests** — mapper tests from fixtures (each mapping rule at least one case, incl. offline runner, busy runner matched to job, run with `self-hosted, windows` labels → `['windows']`, PR with null rollup, conflict PR, draft PR, null repo alias, title with quotes in query builder). Poller tests with a fake client object (`rest`/`graphql`/`lastRate` stubs) and real `Store`: happy path fills store; repo A runners 403 + repo B ok → runners from B, collector ok; all runners 401 → collector error `błąd 401`, previous runners kept; client null → errors, no calls; rate remaining 400 → `slowed:true`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Teeth:** make 403 count as failure → mixed test fails; swap conflict/blocked order → test fails. Restore.
- [ ] **Step 6: Commit** `feat: GitHub mappers and poller`.

---

### Task 6: Alert rules and toast sender

**Files:**
- Create: `src/notify/rules.ts`, `src/notify/toast.ts`
- Test: `test/notify/rules.test.ts`, `test/notify/toast.test.ts`

**Interfaces:**
- Consumes: `DashboardState`, `Store.onChange` listener shape `(next, prev)`.
- Produces:
```ts
// rules.ts
export interface Alert { key: string; title: string; message: string }
export function createAlertEngine(): { evaluate(next: DashboardState, prev: DashboardState): Alert[] }
// toast.ts
export type Notify = (opts: { title: string; message: string; sound: boolean; appID?: string; wait: false }) => void;
export function createToaster(opts: { enabled: () => boolean; notify?: Notify; log?: (m: string) => void }): (alerts: Alert[]) => void
// default notify = node-notifier's notify; errors from notify are caught and logged, never thrown
```
Rules (engine keeps internal state; a "baseline" per collector):
- Sessions: alert when a session id exists in both prev and next, prev state ≠ `waiting`, next state = `waiting`. Title `Czeka: <project>`, message = detail (+ ` · <task>` if task non-empty). Transitions to `unknown` → no alert. New sessions → no alert.
- Runners: engine keeps `offlineStreak[id]` and `alertedOffline[id]`. Streak counts consecutive evaluations where the runners array object changed (new poll) and the runner is offline. When streak reaches 2 and not alerted → alert `Runner offline: <name>`, message `<os>`, set alerted. When runner is online and alerted → alert `Runner znowu online: <name>`, clear. Runners present in the very first non-empty runners array the engine sees are the baseline: if they are offline at baseline, mark them alerted (no toast).
- PRs: by `id` present in prev and next: checks → `fail` from non-fail: `Checki nie przeszły: <repo> #<n>`, message title; merge → `ready` from non-ready: `Gotowy do merge: <repo> #<n>`.
- Same `key` (`session:<id>:waiting:<since>`, `runner:<id>:offline`, `pr:<id>:fail`, …) never emitted twice in a row.
- Toaster: no-op when `enabled()` false; one `notify` call per alert with `sound: true`, `wait: false`, `appID: 'dev-dashboard'`.

- [ ] **Step 1: Failing tests** — session working→waiting alerts; waiting→waiting (detail change) no alert; new session waiting no alert; working→unknown no alert; runner offline 1 poll no alert, 2 polls one alert, 3 polls no extra; offline→online alert; runner offline at baseline → no alert ever until it comes online (then online alert); same runners array object passed twice (no new poll) does not advance streak; PR fail transition; PR ready transition; restart scenario: engine fresh, first evaluate(next=prev=restored state) → no alerts. Toaster: disabled → no calls; notify throws → no throw, log called.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Teeth:** change streak threshold to 1 → test fails. Restore.
- [ ] **Step 6: Commit** `feat: alert rules and Windows toast sender`.

---

### Task 7: Frontend page (locked design B "Telemetria")

**Files:**
- Create: `public/index.html`, `public/style.css`, `public/icons.js`, `public/render.js`, `public/app.js`
- Test: `test/public/render.test.js`

Read first: `.claude/DESIGN_DIRECTION.md` (all tokens and rules), `design/telemetria-mockup.dc.html` (layout and markup reference; it is a Claude Design file — copy the visual structure, not the `<x-dc>`/`sc-for` template syntax).

**Interfaces:**
- Consumes: `/api/events` SSE (`event: state`, data = `DashboardState` JSON), `/fonts/jetbrains-mono/{400,500,700}.css`, `/fonts/inter/{500,900}.css`.
- Produces (`public/render.js`, plain ES module, no DOM access, importable by vitest):
```js
export function esc(s)                         // escapes & < > " '
export function fmtDuration(ms)                // <60 s: "teraz"; <60 min: "N min"; <24 h: "N h M min"; else "N d"
export function fmtClock(ts)                   // "HH:MM" local time
export function renderHeader(state, now, connected)  // title, LIVE indicator (only when connected; else "[ROZŁĄCZONO]" in alert color), "SYNC HH:MM:SS", "GH_API r/l", "TOAST ON|OFF"
export function renderWaiting(state, now)      // red fill block when count>0; neutral block "Nic nie czeka" when 0; rows sorted by longest wait first
export function renderTiles(state)             // 4 tiles: Sesje, Runnery, Kolejka CI, Pull requesty (counts as in mockup)
export function renderSessions(state, now)
export function renderRunners(state, now)
export function renderQueue(state, now)
export function renderPrs(state)
export function renderFooter(state)            // rate-limit note when rate.slowed: "Limit GitHub niski: odświeżanie co 2 min do HH:MM"
export function collectorError(status, label)  // "" when ok or never run with no error; else `<p class="err">${label}: ${status.error}, dane z HH:MM</p>` (or ", brak danych" if lastSuccessAt null)
```
Status labels (Polish, uppercase in brackets) and icon colors: exactly the "Status map" table in `.claude/DESIGN_DIRECTION.md`. Icon paths in `public/icons.js` (export `ICON` object) — copy the path data from the mockup's `ICON` constant.
Empty states: `Brak sesji`, `Brak runnerów`, `Kolejka pusta`, `Brak otwartych PR`. Each panel shows `collectorError(...)` above its rows (sessions panel uses `collectors.sessions`, runners `collectors.runners`, queue `collectors.queue`, PR `collectors.prs`; header shows repos error if any).
PR row: `<repo> #<n> / <title>` linked to `url` (`target="_blank" rel="noopener"`), merge tag `[GOTOWY]|[ZABLOKOWANY]|[KONFLIKT]|[DRAFT]|[?]`, checks text (`N z M OK` / `N z M nie przeszło` / `w toku, N z M` / `brak checków`), review text (`zatwierdzony` / `prośba o zmiany` / `czeka na review` / `draft` / `bez review`).
Queue row detail: in_progress `N min · <runnerName>`; queued `czeka N min · potrzebuje: <labels joined by ", ">`.
Runner row detail: busy `<repo> · <workflow> #<n> · N min`; idle `wolny`; offline `offline`.

`public/app.js`: `EventSource('/api/events')`; on `state` store it and render all sections into fixed containers by id; re-render waiting/sessions/queue/runners every 1 s for ticking times; on `error` mark disconnected (EventSource reconnects by itself); `document.title = waiting>0 ? '(N) Dev dashboard' : 'Dev dashboard'`. Counter element has `aria-live="polite"`.

`public/index.html`: `<html lang="pl">`, links font CSS and `style.css`, static skeleton with section containers (`#header`, `#waiting`, `#tiles`, `#sessions`, `#runners`, `#queue`, `#prs`, `#footer`), `<script type="module" src="/app.js">`. `@media (prefers-reduced-motion)` no animation (there is none anyway). No inline event handlers.

- [ ] **Step 1: Failing tests** (`test/public/render.test.js`, import from `../../public/render.js`): `esc('<script>&"')`; session task `<img onerror>` rendered escaped in `renderSessions` and `renderWaiting`; `fmtDuration` boundaries (59 s, 60 s, 59 min, 60 min, 25 h); waiting block contains `Nic nie czeka` and no alert class at 0; red block class at 3 and rows ordered by oldest `since` first; every status in the Status map renders its label; collectorError with lastSuccessAt → contains `dane z HH:MM`; with ok → `''`; footer shows note only when `slowed`; PR merge tags; queue detail strings.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Teeth:** remove `esc()` call in session row → XSS test fails. Restore.
- [ ] **Step 6: Manual look:** start a static check: `node -e` is not enough — run Task 8's server if present, else write a throwaway script in `/tmp` that serves `public/` with a fixture state (copy the mockup's sample data) and take a Playwright screenshot at 1440×1100, deviceScaleFactor 1; compare with the mockup; fix layout issues. Do not commit the throwaway script.
- [ ] **Step 7: Commit** `feat: dashboard page in Telemetria design`.

---

### Task 8: Wiring (`main.ts`), README, end-to-end smoke test

**Files:**
- Create: `src/main.ts`, `src/app.ts`, `README.md`, `test/e2e/smoke.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
```ts
// src/app.ts — testable composition root
export async function startApp(opts: { config: Config; token: string | null; fetch?: typeof fetch; notify?: Notify; publicDir?: string; fontsDir?: string }): Promise<{ url: string; store: Store; close(): Promise<void> }>
// - store with loadSessions(<dataDir>/sessions.json), toasts = config.toasts
// - saver: on every change save sessions; flush on close
// - sweep timer every 60 s
// - alert engine + toaster subscribed to store.onChange
// - GitHubPoller(client = token ? new GitHubClient({token, fetch}) : null).start()
// - HTTP server on 127.0.0.1:config.port (port 0 allowed for tests); url = `http://127.0.0.1:<port>`
// src/main.ts: loadConfig(), resolveToken(), startApp(), print `Dev dashboard: <url>` and a warning line if token is null; SIGINT/SIGTERM -> close() then exit 0.
```
If port is in use, print `Port 4317 zajęty — czy dashboard już działa?` and exit 1.

README (English): what it is, requirements (Node ≥ 20, Windows 10/11 for toasts, `gh` logged in or `GITHUB_TOKEN` read-only PAT with `repo` read + "Administration: read" for runners), setup (`npm install`, `npm run install-hooks`, `npm start`, open `http://localhost:4317`), config env vars table, how sessions are detected (hook events table), autostart on Windows via Task Scheduler (`At log on`, action `cmd /c cd /d <repo> && npm start`), uninstall hooks, troubleshooting (no sessions → check hooks in `~/.claude/settings.json`; runners error 403 → token needs Administration: read), manual 5-minute Windows checklist from the spec, limitations (cloud sessions: spike pending).

- [ ] **Step 1: Failing smoke test**: `startApp` with port 0, temp dataDir, fake `fetch` that serves fixture responses for `/user/repos`, runs, jobs, runners, graphql (reuse Task 5 fixtures), fake `notify` collecting calls. Then: GET `/api/state` → repos/runners/prs filled; POST hook UserPromptSubmit then PermissionRequest for the same session → one `notify` call with title `Czeka: <project>`; `close()`; start again with same dataDir → session restored and no new notify calls on start; GET `/` returns the real `index.html`.
- [ ] **Step 2–4:** FAIL → implement → PASS. `npm test && npm run typecheck`.
- [ ] **Step 5:** Run `DEV_DASHBOARD_PORT=4399 timeout 5 npm start` — expect the URL line and the missing-token warning (no token in CI container), exit by timeout without stack trace.
- [ ] **Step 6: Commit** `feat: app wiring, README and smoke test`.

---

## Self-review notes

- Spec coverage: hooks (T1,T3), persistence (T2), runners incl. offline + org runners (T5), queue with labels (T5), PRs (T5), active repos (T4/T5), ETag + slowdown (T4/T5), collector isolation (T5/T7), alerts + debounce + no startup toasts (T6/T8), page + design (T7), README/manual checklist (T8). Cloud spike: out of scope (needs owner's Windows machine).
- Deviation from spec: SSE sends full state on every change instead of diffs (state is small; simpler client).
