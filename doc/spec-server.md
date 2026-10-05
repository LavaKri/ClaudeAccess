# Server specification

What the server does today. For the user-facing behaviour see
`spec-interface.md`; for the history of decisions see `plan.md`; for what is
still undecided see `open-questions.md`.

Last updated: 2026-10-05.

## 1. Role and launch

- Node.js + Express 5 + `ws`, no build step. Code in `server/`.
- Serves the static front end (`front/`), a small REST API, and one WebSocket
  channel that carries the conversation with the `claude` CLI.
- Local, single-user: it listens on `host:port` from the configuration
  (default `localhost:1080`) and has no authentication.
- Launch: `npm start`, `npm run dev` (nodemon), or the `:mock` variants, which
  force `mock/cli-mock.js` instead of the configured CLI. The listen address
  only changes on restart.

## 2. Persistent state (all outside the repository, in `~/.claude-access/`)

The server keeps no session state of its own: conversations live in Claude
Code's own files (`<claudeHomeDir>/projects/<encoded-cwd>/<sessionId>.jsonl`).
It owns only two small files.

### 2.1 `config.json` (`server/config.js`)

Global preferences, merged over defaults and sanitised on every read and write
(unknown keys are dropped: restart the server after adding a key).

| Key | Default | Meaning |
|---|---|---|
| `host`, `port` | `localhost`, `1080` | Listen address (restart needed) |
| `claudeHomeDir` | `~/.claude` | Where Claude Code keeps its state |
| `cliCommand` | `claude` | Free-form CLI invocation, split into argv without any shell |
| `messagesPerPage` | `20` | Message log pagination |
| `sessionsPerPage` | `10` | Session and workspace list pagination |
| `titlePreviewWordCount` | `20` | Words in a reply's heading preview |
| `language`, `theme` | `''` | Empty = auto-detect in the browser |
| `completionSound` | `true` | Sound at the end of a response |
| `progressAnnounce` | `true` | Progress line announced by the screen reader |
| `defaultModel`, `defaultEffort`, `defaultPermissionMode` | `sonnet`, `low`, `default` | Used when a session has no recorded options |

### 2.2 `workspaces.json` (`server/workspaces.js`)

The user's own workspace list, with the state tied to each entry:

```
{ "workspaces": [ { "path", "name"?, "lastSessionId"? } ], "lastWorkspace" }
```

- Only workspaces the user added are in it; nothing enters automatically.
- Sanitised on write: entries need a non-empty `path`, duplicates are dropped
  (same path whatever the case, slash style or trailing separator).
- `GET` also returns `exists`: false until the file has been written once,
  which lets the browser migrate its legacy localStorage data (see the
  interface spec).
- The whole store is read and replaced at once.

## 3. REST API

| Route | Behaviour |
|---|---|
| `GET /api/config`, `PUT /api/config` | Read / update the configuration |
| `GET /api/workspaces`, `PUT /api/workspaces` | Read / replace the workspace store |
| `GET /api/projects` | Directories listed in `~/.claude.json` (`projects`) that have a history folder, most recently used first. Used only to migrate the old list |
| `GET /api/history-projects` | Every history folder on disk, with its real path read from the `cwd` field of its session files (the folder name cannot be decoded). For the "existing workspaces" picker; folders whose path can't be recovered are left out |
| `DELETE /api/projects?cwd=` | Deletes a workspace's whole history and its `~/.claude.json` entry |
| `GET /api/sessions?cwd=` | Sessions of a directory, deduplicated (continued / forked sessions collapse by message-id subset), newest first by start time |
| `GET /api/sessions/:id?cwd=` | One session: title, messages, token usage, last run options |
| `PUT /api/sessions/:id/title` | Renames (appends a `custom-title` line, like `claude` does) |
| `DELETE /api/sessions/:id` | Deletes the session file |
| `POST /api/sessions/:id/duplicate` | Copies a session |
| `POST /api/sessions/:id/move` | Moves a session to another workspace's history |
| `POST /api/pick-folder?lang=` | Opens the native Windows folder dialog on the server machine (PowerShell) and returns the chosen path or `null` |

List responses are sent `no-store` where a stale cache would show deleted
data.

## 4. History reading (`server/history.js`)

- Encoding of a directory to its history folder name: every non-alphanumeric
  character becomes `-`.
- A session is parsed from its JSONL: `ai-title` / `custom-title` for the
  title (custom wins, then AI title, then the last reply's start), per-entry
  `usage` summed into a token total, tool uses turned into `{ kind, label }`
  entries (file read, command, other).
- **Run options**: the latest `model` (full id, `<synthetic>` ignored),
  `effort` and `permissionMode` recorded on the entries are returned as
  `runOptions`.
- **Hidden noise**: assistant entries from the `<synthetic>` model, assistant
  replies that are exactly "No response requested.", and user messages that
  are exactly "continue" are left out of the returned messages. The files on
  disk are never modified.
- Background-task notifications are returned as their own `notification` role.

## 5. WebSocket channel and CLI invocation

Client to server (JSON):
- `prompt`: `{ prompt, model, effort, permissionMode, cwd, sessionId?,
  allowedTools? }`
- `abort`

Server to client: every stdout line of the CLI is forwarded verbatim
(`stream-json`), plus `{ type: 'error', message }` for stderr, spawn failures
and protocol errors, and `{ type: 'result', subtype: 'aborted' }` after an
abort.

Invocation: `<cliCommand> -p <prompt> --output-format stream-json --verbose
--model … --effort … --permission-mode …`, then `--resume <sessionId>` when
there is one and `--allowed-tools a,b` (kept last, it is variadic). No shell
is involved, stdin is ignored, the working directory is the workspace.

- One CLI child per WebSocket connection; a second `prompt` while one runs is
  refused.
- `abort` kills the child.
- In `-p` mode the CLI cannot pause for a permission: a tool that isn't
  allowed comes back as an error and the front end decides what to do (it
  resumes with `--resume` and the tool added to `--allowed-tools`). See the
  permission section of the interface spec.

### Tool error log

Every `tool_result` with `is_error` the CLI emits is written to the server
console as `[tool error] <Tool>: <start of the text>` (300 characters).
Purely informational: it collects the real wording of genuine denials. It
never changes what is forwarded.

## 6. Limits

- Windows-only for the folder picker.
- No authentication and no TLS: meant for the local machine.
- `~/.claude.json` is read only for the migration list and written only when
  deleting a workspace's history.
