# Ideas for a next version

Working notes from a design discussion held on 2026-10-11. Nothing here is
implemented or decided. Statements about Anthropic's documentation were read
online during that discussion (pages cited at the end); statements about
behaviour that was not run are marked "to verify". Re-check the cited pages
before building on them: the CLI and SDK change often.

For what exists today see `spec-server.md` and `spec-interface.md`; for
undecided points already tracked see `open-questions.md`.

## 1. Current architecture, in short

Two parts talking over one WebSocket, in the same Node process:

- `server/`: spawns `claude -p` (no shell), relays its `stream-json` output,
  exposes a few REST routes. Keeps no conversation state: sessions live in
  Claude Code's own files under `<claudeHomeDir>/projects/`. Owns only
  `config.json`, `workspaces.json` and `session-options/` in
  `~/.claude-access/`.
- `front/`: static HTML/CSS/ES modules served as-is. Uses relative URLs and
  `ws://${location.host}/ws` (`front/WsClient.js`), so it already works from
  any host that serves it.
- `mock/cli-mock.js`: a fake `claude` for front-end work.

## 2. Making the app standalone

"Standalone" taken as: starts in one gesture, no `npm start`, ideally no
Node install. From lightest to heaviest:

| Option | Notes |
|---|---|
| Launch script (`.bat` / shortcut) | Starts the server, opens the browser. No accessibility risk |
| Autostart (Task Scheduler, NSSM, `systemd` on Linux) | Server always running; open a bookmark |
| PWA ("install app" from Chrome/Edge) | Dedicated window, same page. JAWS behaviour in that window to test |
| Single executable (Node SEA, `pkg`, `bun build --compile`) | No Node install; still needs a browser |
| Electron | One launch, native folder dialog. Heavy (~150 MB); retest with JAWS on every upgrade |
| Tauri | Lighter (WebView2) but needs Rust, Node still needed as a sidecar |
| Rewrite in .NET or Go | Cleanest to distribute, large cost for little gain |

Recommendation: launch script, then autostart; add a PWA if a dedicated
window is wanted. Electron/Tauri only if the native folder dialog or window
becomes essential.

### Electron and JAWS: what is and is not known

The claim "Electron is worse with JAWS" is too broad. The web content is
rendered by Chromium, same engine as Chrome. What can differ is everything
around it: default menu bar, window title and initial focus, lost browser
shortcuts, custom dialogs, and JAWS's virtual cursor / forms-mode behaviour
in an app window versus a browser. A well-built Electron app can be
accessible. A browser tab remains the lowest-risk choice. If Electron is
tried, test with JAWS first: a ~15-line `main.js` loading
`http://localhost:1080` with the menu hidden, then run send / streamed reply
/ permission request.

## 3. Two modes: normal and remote

Wanted:

1. **Normal**: server and interface together on one PC, as today.
2. **Remote**: server on PC A, interface on PC B.

Design: the server keeps serving the front end, so "interface only" needs no
new program. PC B just opens `https://pc-a:1080` in a browser (or a PWA, or
an Electron window pointed at that URL). The alternative, a front end
installed on B that talks to a remote server, would need configurable URLs,
CORS and version matching; only worth it if B must load the UI without the
server.

Goal stated afterwards: Claude may act on A with wide permissions but must
not be able to act on B. The split already guarantees `claude` runs only on
A; B only displays text.

### Work needed

1. **Config**: a mode (local / server), listen address, shared secret.
   Default stays local.
2. **Authentication**: today reaching the port means running commands as the
   user. Needs a password or token on every REST call and on the WebSocket
   handshake, expiry, and an `Origin` check on the WebSocket (useful even in
   local mode).
3. **Encryption**: pick `wss://` when the page is `https://`. Simplest is not
   to manage certificates: a VPN (Tailscale) or an SSH tunnel
   (`ssh -L 1080:localhost:1080`) leaves `host` on `localhost`/the VPN
   address.
4. **Folder picker**: `/api/pick-folder` (`server/server.js`) opens a
   PowerShell dialog on the server machine, useless remotely and Windows-only.
   Replace with a directory-listing route plus an in-page browser; keep the
   native dialog only for local mode.
5. **Reconnection**: if the link drops mid-reply the `claude` process must
   keep running and the client must be able to reattach to the stream. What
   the server does today in that case was not checked; this is the hardest
   technical point.
6. **Guard rails**: allowed-workspaces list enforced server-side, defaults
   for permissions stored on the server (the client cannot widen them),
   consider forbidding "Bypass permissions" over the network, action log.

### Keeping Claude away from PC B

- No folder synced with B (Dropbox, OneDrive, network share) inside A's
  workspaces. Note this repository itself lives under Dropbox.
- No SSH keys, saved passwords or mounted drives for B on A; firewall B
  against inbound connections from A; deny `ssh` / `net use` / `curl` style
  commands with `disallowedTools` even in wide-permission mode.
- Run the server under a dedicated account, or better in a container / VM,
  so wide permissions are acceptable.
- The reverse risk is larger: whoever holds a session or token on B controls
  A, which is why item 2 above is mandatory.
- If file upload from B to A is ever added, that content becomes input for
  Claude: decide it explicitly.

## 4. PC A on Linux

Node, Express and `ws` run on Linux, and so does Claude Code. Windows-specific
spots found in the server code:

- `server/server.js` (`/api/pick-folder`): spawns `powershell.exe`.
- `server/workspaces.js`, `server/session-options.js`, `server/history.js`:
  paths are lowercased and backslashes rewritten, assuming a case-insensitive
  file system. On Linux `/home/x/Projet` and `/home/x/projet` are different
  directories and would be merged. Lowercase only on Windows.
- `encodeProjectPath` must produce the same history-folder name Claude Code
  creates on Linux, otherwise sessions are not found (to verify).

Linux brings easy isolation (dedicated user, container), a simple firewall
(`ufw`/`nftables`), and `systemd` for an always-on service.

Headless login for a subscription: run `claude` over SSH, open the printed
URL on any other device, paste the code back; credentials are then stored in
`~/.claude/`. No desktop environment is needed. A long-lived token can also
be generated elsewhere with `claude setup-token` and supplied through
`CLAUDE_CODE_OAUTH_TOKEN`. The exact prompts vary with the CLI version (to
verify).

## 5. Agent SDK versus `claude -p`

- The Agent SDK is Claude Code packaged as a library (TypeScript
  `@anthropic-ai/claude-agent-sdk`, Python `claude-agent-sdk`). It runs the
  Claude Code binary underneath, with the same tools, permissions and session
  files, but gives typed events and a `canUseTool` callback instead of
  parsing CLI output. Mapping: `cwd`, `model`, `permissionMode`, `resume`,
  `forkSession`, `includePartialMessages`, `interrupt()`.
- Both SDKs are published by Anthropic (npm maintainers with Anthropic
  accounts; repositories `anthropics/claude-agent-sdk-typescript` and
  `-python`). Both were still `0.x` when checked, so the API is not declared
  stable; pin versions. The release dates returned by the tools used were
  inconsistent and should be re-read from npm / PyPI directly.
- Other languages: no official Agent SDK known. The documented route is to
  run the CLI as a subprocess with `-p` and `--output-format`.
- The regular API SDKs (`anthropic`, Python/TS/Java/Go/Ruby/C#/PHP) are a
  different thing: no built-in tools, files or sessions.

### Licensing (the deciding factor)

From Anthropic's "Legal and compliance" and "Agent SDK overview" pages:

- OAuth / subscription login is meant for ordinary use of Claude Code and
  Anthropic's native apps. Nothing there prevents a user from signing in to
  the **unmodified Claude Code binary** with their own subscription.
- Developers building products with the Agent SDK "should use API key
  authentication". Anthropic does not permit third-party developers to offer
  claude.ai login in their applications or to route requests through Free,
  Pro or Max credentials on behalf of users, nor to collect or relay Claude.ai
  credentials. The overview adds "unless previously approved".
- A strictly personal tool using one's own subscription through the SDK is
  not addressed by the text. Anthropic reserves the right to enforce without
  notice and suggests contacting sales for specific cases.

Consequence: staying on `claude -p` (unmodified binary, own subscription) is
the clearly covered path. The SDK is clearly covered with an API key
(per-token billing). SDK plus subscription needs written confirmation from
Anthropic. The SDK's benefits (types, callback permissions) do not currently
justify that risk.

## 6. Better permission handling without the SDK

Moved to `claude-p-usage.md` (2026-10-17): the solutions compared there,
their licensing, difficulty and tests. The `PermissionRequest` HTTP hook
recommended here was tested and works with the installed CLI; it is the
recommended next step.

Still specific to the remote and Linux goals of this file: a `PreToolUse`
hook or `--disallowedTools` rules decided by the server (deny `ssh`,
`net use`, `curl`-style commands, auto-allow reads inside the workspace),
applied whatever the browser asks (section 3, item 6).

## 7. Suggested order

1. Permission hook (section 6): experiment done on 2026-10-17, implementation
   next (see `claude-p-usage.md`).
2. Launch script / autostart (section 2).
3. Remote mode groundwork: config, authentication, `Origin` check,
   `wss://` by page protocol (section 3, items 1-3).
4. Folder browser in the page; OS-independent paths (sections 3-4).
5. Reconnection / stream reattach (section 3, item 5).
6. Optional dedicated window (PWA or Electron), only after a JAWS test.

## Sources read on 2026-10-11

- https://code.claude.com/docs/en/legal-and-compliance
- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/hooks
- https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk
- https://pypi.org/pypi/claude-agent-sdk/json
