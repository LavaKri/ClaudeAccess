# ClaudeAccess

A minimal, custom web interface for `claude -p`, built to be fully accessible
with the JAWS screen reader. It exists to work around accessibility
limitations of the official Claude Desktop and Claude CLI (interactive mode)
apps with JAWS, by driving `claude` in print/non-interactive mode
(`claude -p`) from a small self-hosted web UI instead.

See [plan.md](plan.md) for the phased implementation plan and the
architecture decisions behind it.

## Stack

- Node.js, no build step / bundler for the frontend.
- `server/`: all backend logic (the single long-lived `claude -p` process in
  `cliProcess.js`, WebSocket handling, on-disk session history).
- `front/`: static files served as-is by Express (plain HTML/CSS/JS,
  ES modules, no framework).
- Express serves `front/` and any auxiliary REST routes (e.g. recent working
  directories, recent sessions).
- `ws` handles the WebSocket channel used for the streaming conversation
  (spawn output, permission requests).
  `socket.io` is deliberately not used: no polling fallback or rooms are
  needed here.

## Commands

- `npm run start` — start the server against the real `claude` CLI.
- `npm run dev` — same, with `nodemon`, restarting on file changes.
- `npm run start:mock` / `npm run dev:mock` — same, but forced onto
  `mock/cli-mock.js` instead of the real CLI, regardless of the configured
  `cliCommand` — for frontend/protocol work without consuming real usage.

## Conventions

- No dependencies beyond what's required for Express/WebSocket/dev reload
  (plus `multer` for prompt attachment uploads) — keep the project minimal
  and easy to audit.
- Documentation (this file, README, code comments) is written in English to
  keep the door open for a future public release. Conversations with the
  user may happen in French. `plan.md` is the one exception: kept as
  informal, French-language internal working notes rather than polished
  public documentation — see the banner at the top of that file.
- Accessibility is a first-class constraint, not a final cleanup pass: any
  UI change involving dynamic content must consider screen reader behavior
  (`aria-live` regions, focus management, no destructive re-renders of
  content a screen reader is tracking) as part of the change itself.
- The `claude` CLI invocation (`cliCommand` in the app's own config, editable
  from the options page) defaults to the real `claude` binary. Use
  `npm run start:mock` / `dev:mock` to force the mock instead, without
  touching that config. See `plan.md` step 1 for the mock's scenarios.
- The app version is the date of the last change, `year.month.day` without
  leading zeros (e.g. `2026.11.1`), held in `front/appInfo.js` and
  `package.json`. It is bumped automatically on each commit by
  `.githooks/pre-commit` (enable once per clone with
  `git config core.hooksPath .githooks`); `npm run bump-version` does the
  same by hand. Never edit the version manually.
- When manual testing needs a real `claude -p` run (not the mock) and the
  actual response content doesn't matter, use the cheapest model/effort
  combination (`sonnet`+`low`, or `haiku`) to minimize usage cost.
