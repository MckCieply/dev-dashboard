# dev-dashboard

A local Node service and web page (`http://localhost:4317`) that shows, in one place:

- Claude Code sessions (working / waiting / unknown), fed by Claude Code hooks;
- self-hosted GitHub Actions runners (idle / busy / offline);
- the Actions run queue with required labels and wait time;
- open pull requests (checks, review, merge state).

It fires Windows toasts (with sound) when something needs you: a session starts waiting, a runner goes offline or comes back, PR checks fail, a PR becomes ready to merge. The UI is in Polish; code and docs are in English.

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
| `SessionStart` | waiting | nowa sesja (no toast) |
| `UserPromptSubmit` | working | myśli |
| `PreToolUse` | working | tool name |
| `PostToolUse` | working | unchanged |
| `PermissionRequest` | waiting | prośba o zgodę: tool |
| `Notification` (permission prompt) | waiting | prośba o zgodę: tool |
| `Notification` (idle) | waiting | czeka na odpowiedź |
| `Stop` | waiting | odpowiedź gotowa |
| `SessionEnd` | removed | |
| no event for 30 min while working | unknown | brak zdarzeń N min |
| no event for 12 h in any state | removed | |

Session id is `session_id`, project is the last segment of `cwd`, task is the first line of the first prompt (max 60 chars). Sessions are kept in `sessions.json`, so a restart keeps them and does not re-toast them.

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
- No toasts: check `DEV_DASHBOARD_TOASTS` and Windows Focus assist / notification settings.

## Manual 5-minute checklist (Windows)

1. `npm start`; the console prints `Dev dashboard: http://127.0.0.1:4317`.
2. Open `http://localhost:4317`; the header shows `LIVE`.
3. Start a Claude Code session in any project; it appears in the list.
4. Trigger a permission prompt; a toast `Czeka: <project>` plays a sound and the session shows `[CZEKA]`.
5. Stop a self-hosted runner; after about 60 s an offline toast appears and the runner shows offline. Start it again and expect the back-online toast.
6. Restart the service while a session is waiting: it is still listed and no toast fires.

## Limitations

- Claude Code cloud sessions are not covered yet (spike pending). The hook script already sets `dd_where` to `chmura` when `CLAUDE_CODE_REMOTE=true`, so such sessions are marked once their events reach the service.
- GitHub data is polled (every 30 s), not pushed.
- Toasts rely on `node-notifier` (SnoreToast on Windows).
