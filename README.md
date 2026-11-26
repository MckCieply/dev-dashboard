# dev-dashboard

A local Node service and web page (`http://localhost:4317`) that shows, in one place:

- Claude Code sessions (working / waiting / unknown), fed by Claude Code hooks;
- self-hosted GitHub Actions runners (idle / busy / offline);
- the Actions run queue with required labels and wait time;
- open pull requests (checks, review, merge state).

It fires Windows toasts (with sound) for GitHub and runner events only: a PR starts needing a human, PR checks fail, a PR becomes ready to merge, a PR is merged, a runner goes offline or comes back. Claude sessions never raise a toast; they are shown on the page. The UI is in Polish; code and docs are in English.

## Requirements

- Node >= 20.
- Windows 10/11 for toasts (the page and the collectors also run on Linux/macOS; toasts are then best effort).
- GitHub access, either:
  - `gh` installed and logged in (`gh auth login`), or
  - env `GITHUB_TOKEN` (or `GH_TOKEN`) with a read-only PAT: `repo` read, plus "Administration: read" for runners.

Token lookup order: `gh auth token`, then `GITHUB_TOKEN`, then `GH_TOKEN`. Without a token the Claude sessions panel still works; GitHub panels show an error line.

## Setup

```
npm install
npm run install-hooks    # shows a diff of ~/.claude/settings.json and asks before writing
npm start
```

Open `http://localhost:4317`. The server binds to `127.0.0.1` only.

Remove the hooks with `npm run uninstall-hooks`.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `DEV_DASHBOARD_PORT` | `4317` | HTTP port. |
| `DEV_DASHBOARD_DATA_DIR` | `%LOCALAPPDATA%\dev-dashboard` (Windows), `~/.local/state/dev-dashboard` (other) | Where `sessions.json` is kept. |
| `DEV_DASHBOARD_TOASTS` | on | `0` or `false` disables toasts. |
| `DEV_DASHBOARD_ORGS` | empty | Comma list of extra orgs whose org-level runners to show. |
| `DEV_DASHBOARD_URL` | `http://127.0.0.1:4317/hook` | Read by the hook script; set it if you changed the port. |
| `GITHUB_TOKEN`, `GH_TOKEN` | none | Fallback tokens when `gh auth token` fails. |

## How sessions are detected

`hooks/report.mjs` is registered as a Claude Code hook. It POSTs the hook payload to `/hook` (fire-and-forget, 2 s timeout, always exits 0, prints nothing), so it never blocks Claude Code.

| Hook event | Session state | Detail |
|---|---|---|
| `SessionStart` | waiting | nowa sesja |
| `UserPromptSubmit` | working | myśli |
| `PreToolUse` | working | tool name |
| `PostToolUse` | working | tool name |
| `PermissionRequest` | waiting | prośba o zgodę: tool |
| `Notification` (permission prompt) | waiting | prośba o zgodę: tool |
| `Notification` (idle) | waiting | czeka na odpowiedź |
| `Stop` while a background subagent or workflow runs | working | czeka na subagenta |
| `Stop` while a background shell waits for a PR or CI, and no question is open | working, tag `[CZEKA NA PR]` | czeka na PR #N, or czeka na CI |
| `Stop` otherwise (other background shells do not count) | waiting | odpowiedź gotowa |
| `SessionEnd` | removed | |
| no event for 30 min while working (3 h during a PR or CI wait) | unknown | brak zdarzeń |
| no event for 12 h in any state | removed | |

### Waiting for a PR

A background shell counts as a PR or CI wait when its command runs `wait-pr`, `gh run watch`, `gh pr checks --watch`, or an `until`/`while` loop with `sleep` and `gh pr`, `gh run` or `gh api`. The session still waits for you when it asked something: a question mark in the last paragraph of its final message, or a question in the desktop app next-step box (`mcp__ccd_turn__wrap_up` with `ask`). While a session waits on background work, the idle notification is ignored.

Not detected: a PR watched only by the desktop app CI monitor, because it leaves no background task.

An open permission request stays on screen until the asking agent (or the asked tool) reports a tool event, so parallel subagents do not hide it.

Session id is `session_id`. A session is shown under its human-readable name: the last `custom-title` entry in its transcript (`~/.claude/projects/*/<session_id>.jsonl`, re-read every 5 s). Without one, the name is the first line of the first prompt the user typed (max 60 chars; harness blocks such as `<system-reminder>` or `<task-notification>` are skipped), then "Sesja bez nazwy". Branch, folder and environment names are never used as the name. Sessions are kept in `sessions.json`, so a restart keeps them.

## Pull requests

- The list covers open PRs of your active repos. Failing checks come before ready ones.
- "Needs a human" means an open PR with label `needs-human` and without `human-approved` (case-insensitive). The search covers every non-archived repo you have, not only active ones. Such PRs head the "Czeka na Ciebie" block and the PR list with a red `[NEEDS HUMAN]` tag.
- Merged PRs of the last 24 h are read for the "merged" toast.
- Toasts for needs-human and merged fire once per PR. What already exists at the first poll after a start stays silent.
- Each toast kind has its own icon in `assets/toast/`; regenerate them with `npm run icons`. Windows toast backgrounds cannot be colored, so the color is in the icon.

The browser tab icon turns red when something waits for you.

## Autostart on Windows (Task Scheduler)

1. Open Task Scheduler, "Create Task".
2. Trigger: "At log on".
3. Action: start a program `cmd`, arguments `/c cd /d C:\path\to\dev-dashboard && npm start`.
4. Untick "Stop the task if it runs longer than".

## Troubleshooting

- No sessions appear: check that `~/.claude/settings.json` contains the dashboard hooks (re-run `npm run install-hooks`), that the service is running, and that the port matches `DEV_DASHBOARD_URL`. Restart the Claude Code session after installing hooks.
- Runners show `błąd 403`: the token needs "Administration: read" (and you need admin rights on the repo or org).
- `Port 4317 zajęty — czy dashboard już działa?`: another instance is running; stop it or set `DEV_DASHBOARD_PORT`.
- GitHub panels say `brak tokenu GitHub`: run `gh auth login` or set `GITHUB_TOKEN`.
- Footer shows a rate-limit note: fewer than 500 requests left, polling slows to every 120 s until the reset.
- No toasts: check `DEV_DASHBOARD_TOASTS`. On Windows also check Settings > System > Notifications for an entry named "SnoreToast" (it must be on) and that Focus Assist / Do Not Disturb is off.
- `403 forbidden host/origin` or `415`: the server only answers requests whose `Host` is `127.0.0.1`, `localhost` or `[::1]` on its own port, rejects POSTs with a foreign `Origin`, and `/hook` needs `Content-Type: application/json`.

## Manual 5-minute checklist (Windows)

1. `npm start`; the console prints `Dev dashboard: http://127.0.0.1:4317`.
2. Open `http://localhost:4317`; the header shows `LIVE`.
3. Start a Claude Code session in any project; it appears in the list.
4. Trigger a permission prompt; the session shows `[CZEKA]` and no toast fires.
5. Stop a self-hosted runner; after about 60 s an offline toast appears and the runner shows offline. Start it again and expect the back-online toast.
6. Restart the service while a session is waiting: it is still listed.
7. Add label `needs-human` to an open PR; within 30 s it heads the "Czeka na Ciebie" block and one toast plays a sound.

## Limitations

- Claude Code cloud sessions are not covered yet (spike pending). The hook script already sets `dd_where` to `chmura` when `CLAUDE_CODE_REMOTE=true`, so such sessions are marked once their events reach the service.
- GitHub data is polled (every 30 s), not pushed.
- Toasts rely on `node-notifier` (SnoreToast on Windows).
