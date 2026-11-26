# Dev dashboard — design spec

Date: 2026-11-26. Status: draft for owner review.

## Goal

One local page that answers, at a glance:

1. Which Claude Code sessions are working and which wait for the owner's input.
2. Whether the self-hosted CI runners are busy, idle or offline (all of them).
3. What is in the GitHub Actions queue (queued and in progress).
4. The state of open PRs in active projects (checks, review, mergeable, draft).

It alerts with a Windows toast and a sound when something changes state.

## Scope

**In v1**
- Local Claude Code sessions on the owner's Windows machine, via hooks.
- GitHub data: runners, run queue, PRs for active repos.
- Windows toast + sound on state change.
- Read-only page at `http://localhost:4317`.

**Not in v1**
- Cloud Claude Code sessions in production. A ~1 h throwaway spike checks
  whether a cloud session's hooks can POST to this service through a
  Cloudflare Tunnel. Result decides "option B" (public hosting) later.
- Any action from the dashboard (approve, merge, re-run, answer a session).
- Multi-user, auth, history charts.

## Decisions taken

| Topic | Decision | Rejected |
|---|---|---|
| Build vs fork | Own small service | Forking existing session monitors: they cover sessions only, not runners/PRs |
| Runtime | Node + TypeScript, one process, `npm start` | Electron app; separate services |
| Hosting | localhost on Windows first | Public host now |
| Repos tracked | Automatic: pushed in the last 14 days | Manual list |
| Alerts | Toast + sound, only on state change | Alert on every poll; no alerts |
| Session source | Claude Code hooks | `claude agents --json` (unverified), log scraping |
| Visual direction | B "Telemetria", locked in `.claude/DESIGN_DIRECTION.md` | A "Linear", C "Toviq cynk i lód" |

## Part 1 — Architecture

```
Claude Code hooks ──POST /hook──┐
                                ▼
GitHub REST/GraphQL ◄─poll── [ dev-dashboard (Node) ] ──SSE──► browser page
                                │
                                └──► Windows toast + sound
```

- One Node process. Four independent collectors write into one in-memory state
  store. The store emits change events.
- HTTP server on `127.0.0.1:4317` (bound to loopback only):
  - `GET /` — the page (static HTML/CSS/JS, fonts self-hosted).
  - `GET /api/state` — full state snapshot as JSON.
  - `GET /api/events` — Server-Sent Events: a snapshot on connect, then diffs.
  - `POST /hook` — Claude Code hook events.
- Notifier subscribes to store transitions and fires toasts.
- Session state persists to `%LOCALAPPDATA%\dev-dashboard\sessions.json`
  (debounced write), so a restart keeps known sessions.

## Part 2 — Collectors

### 2.1 Claude sessions (hooks)

- A Node hook script `hooks/report.mjs` is registered in the owner's user
  `settings.json` for: `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
  `PostToolUse`, `Notification`, `Stop`, `SessionEnd`.
- It reads the hook JSON from stdin and POSTs it to `http://127.0.0.1:4317/hook`.
  Fire-and-forget, 2 s timeout, always exits 0 so it never blocks Claude Code.
- An install script adds the hook entries; it shows the diff and asks before writing.
- Session id = `session_id`. Project = last segment of `cwd`. Task = first line
  of the first user prompt, cut to 60 chars. Where = `lokalna` (v1).

State machine:

| Event | New state | Detail |
|---|---|---|
| `SessionStart` | waiting | "nowa sesja" |
| `UserPromptSubmit` | working | "myśli" |
| `PreToolUse` | working | tool name |
| `PostToolUse` | working | (unchanged) |
| `Notification` (permission prompt) | waiting | "prośba o zgodę: <tool>" |
| `Notification` (idle) | waiting | "czeka na odpowiedź" |
| `Stop` | waiting | "odpowiedź gotowa" |
| `SessionEnd` | removed | — |
| no event 30 min while working | unknown | "brak zdarzeń N min" |
| no event 12 h in any state | removed | — |

`since` = time of entering the current state.

### 2.2 Active repos

- `GET /user/repos?affiliation=owner,collaborator,organization_member&sort=pushed`,
  keep repos with `pushed_at` within 14 days. Refresh every 10 min.

### 2.3 Runners

- Per active repo: `GET /repos/{o}/{r}/actions/runners`. Also per owned org if
  any: `GET /orgs/{org}/actions/runners`. Deduplicate by runner id.
- Needs "Administration: read". Without it the panel shows the error state
  (see Part 3), the rest keeps working.
- State: `offline` if `status=offline`; else `busy` if `busy=true`; else `idle`.
- Busy runner detail: matching in-progress job (repo, workflow, run number, duration)
  from the queue collector when it can be matched by `runner_name`.

### 2.4 Run queue

- Per active repo: `GET /repos/{o}/{r}/actions/runs?status=queued` and
  `?status=in_progress`. For queued runs, fetch jobs to show required labels
  (`potrzebuje: windows`) and wait time.

### 2.5 PRs

- One GraphQL query per poll over active repos: open PRs with `isDraft`,
  `reviewDecision`, `mergeable`, `mergeStateStatus`, and
  `commits(last:1){ statusCheckRollup { state contexts { totalCount } } }`.
- Display: checks (`N z M OK` / `N nie przeszło` / `w toku`), review
  (zatwierdzony / prośba o zmiany / czeka na review / draft), merge state
  (gotowy do merge / zablokowany / konflikt / draft).

### 2.6 Polling and rate limit

- GitHub collectors every 30 s, with `If-None-Match` ETags (304 does not count
  against the limit).
- Token: `gh auth token` at start, else `GITHUB_TOKEN` env (read-only PAT).
- If `x-ratelimit-remaining` < 500: poll every 120 s and show a footer note
  until the reset time.

## Part 3 — Errors, alerts, tests

### Errors

- Each collector keeps its own `{ok, lastSuccessAt, error}`. A failing collector
  shows a red line in its panel: `GitHub: błąd 401, dane z 14:32`. Its last data
  stays visible and is marked stale. Other panels are unaffected.
- Hook server down: hook script times out silently; sessions catch up on the next event.
- Page loses SSE: shows `[ROZŁĄCZONO]` in the header and reconnects with backoff.

### Alerts (Windows toast + sound)

- Fire once per transition, never per poll:
  - session → waiting (title: project, body: reason); not for `SessionStart`;
  - runner → offline, only after 2 consecutive offline polls (~60 s);
  - runner offline → online;
  - PR checks → fail; PR → ready to merge.
- No toast at startup for states that already existed.
- Library: `node-notifier` (SnoreToast on Windows). Toasts can be muted from
  the config file.

### Tests

- vitest unit tests, each checked by breaking the guarded code once ("teeth"):
  - session state machine (every row of the table in 2.1, plus 30 min / 12 h timers with fake timers);
  - toast logic: once per transition, offline debounce, no startup toasts;
  - active-repo filter (14-day edge);
  - GitHub mapping on recorded JSON fixtures (runners, runs, jobs, GraphQL PRs);
  - rate-limit slowdown threshold.
- Hook script: test it posts stdin and exits 0 when the server is down.
- Manual 5-min checklist on Windows: start service, open page, start a session,
  trigger a permission prompt, see toast + `[CZEKA]`, stop a runner, see offline toast.

## Part 4 — Visual design

- Locked direction: `.claude/DESIGN_DIRECTION.md` (B "Telemetria", Tactical
  Telemetry brutalism). Mockup: `design/telemetria-mockup.dc.html`.
- Page layout, top to bottom:
  1. Header bar: title, `LIVE` indicator, last sync time, GitHub limit, toast on/off.
  2. "Czeka na Ciebie": red fill counter (count + longest wait), list of waiting
     sessions with project, task, reason, where, wait time. Longest wait first.
  3. Four stat tiles: Sesje, Runnery, Kolejka CI, Pull requesty.
  4. Three panels: Sesje (all) | Runnery + Kolejka runów | Pull requesty.
- Empty states: "Nic nie czeka" in the waiting block (block turns neutral, not red);
  "Brak runnerów" / "Kolejka pusta" / "Brak otwartych PR".
- Wait times tick every second client-side; data updates via SSE without reload.
- After the UI is built: audit with `web-design-guidelines`.

## Open items

- Cloud session spike (~1 h, needs the owner's Windows machine and a tunnel).
- Whether runners are registered per repo or per org: collector supports both.
