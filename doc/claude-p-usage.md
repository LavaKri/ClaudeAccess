# Driving `claude -p`: permissions and dialogs with the user

How ClaudeAccess can let the user answer what `claude -p` needs from them
(tool permissions, clarifying questions, plan approval), the solutions
available, what each one is worth, and what was tested. For what the app does
today see `spec-server.md` (section 5) and `spec-interface.md` (section 7);
for what is still undecided see `open-questions.md`.

Last updated: 2026-10-17. CLI version installed and tested: 2.1.286.

## 1. Sources and how far to trust them

- Official documentation, read on 2026-10-17 (raw Markdown downloaded for every
  point that matters: an automatic summary of the hooks page turned out to be
  invented and contradicted the real text):
  `cli-reference`, `headless`, `permission-modes`, `permissions`, `hooks`,
  `hooks-guide`, `tools-reference`, `sessions`, `mcp`, `legal-and-compliance`,
  `authentication`, `agent-sdk/overview`, `agent-sdk/permissions`,
  `agent-sdk/user-input`, `agent-sdk/streaming-vs-single-mode`,
  `agent-sdk/typescript`, all under `https://code.claude.com/docs/en/`.
- `claude --help` of the installed CLI. It does not list every flag
  (`--permission-prompt-tool` is missing from it but documented online).
- Real runs: the 2026-10-06 runs (see section 8) and the 2026-10-17 hook spike
  (section 4.B). Spike runs used `haiku` + effort `low` in a scratch folder,
  about 0.02 to 0.05 USD each, 0.45 USD in all.
- Statements marked *(doc)* come from the documentation only; *(tested)* were
  seen on a real run.

## 2. What `claude -p` does with permissions

- A tool call that needs approval and that nothing approves (permission mode,
  allow rule, hook) is **denied** in `-p` when the run has no permission host.
  The CLI does not stop: the model sees the error and usually asks for the
  permission in plain text, then the run ends with `success` *(doc, tested)*.
- Every denial is announced by a `system/permission_denied` message (with
  `tool_name`, `tool_use_id`, `message`, and `decision_reason_type` /
  `decision_reason` when a hook or rule decided). The doc calls it
  best-effort: the `permission_denials` array of the final `result` is the
  authoritative record *(doc, tested)*.
- A **permission host** is either an Agent SDK `canUseTool` callback or an MCP
  tool named with `--permission-prompt-tool`. With one, the CLI waits for its
  answer instead of denying *(doc)*. `--permission-prompts none` (v2.1.259+)
  forces the deny-and-continue behaviour even when a host exists *(doc)*.
- `AskUserQuestion` (multiple-choice questions) and `ExitPlanMode` (plan
  approval) are only offered to the model in `-p` when the run has a permission
  host *(doc)*. ClaudeAccess has none today, so the model can neither ask a
  structured question nor submit a plan for approval. In `plan` mode the model
  writes its plan as text, or into `~/.claude/plans/` *(tested)*.
- `PermissionRequest` hooks still run in `-p` (except in `dontAsk` mode) and can
  allow or deny in place of the missing prompt *(doc, tested)*.
- Mode facts used below *(doc)*: `default` (Manual) asks for everything but
  reads; `acceptEdits` also allows file edits and `mkdir`, `touch`, `rm`,
  `rmdir`, `mv`, `cp`, `sed` inside the working directories; `dontAsk` denies
  anything that would prompt and never calls a host or a `PermissionRequest`
  hook; `bypassPermissions` allows everything except the actions no mode
  auto-approves (ask rules, `AskUserQuestion`, critical-path removals...). Deny
  rules win in every mode.

## 3. Licensing (applies to every solution)

From `legal-and-compliance` and `agent-sdk/overview`, read on 2026-10-17:

- Subscription (OAuth) login is meant for "ordinary use of Claude Code and other
  native Anthropic applications", and nothing "prevent[s] an end user from
  signing in to the unmodified Claude Code binary with their own Claude
  subscription".
- Not allowed: third-party developers offering claude.ai login in their own
  applications, routing requests through Free, Pro or Max credentials on behalf
  of their users, or collecting, storing or relaying Claude.ai credentials or
  session tokens.
- Products built on the Agent SDK must use API-key authentication unless
  Anthropic approved otherwise.

What this means for ClaudeAccess: it runs the unmodified `claude` binary,
never sees the credentials (the user logs in through the CLI's own flow) and
serves one person. That is the covered case. It stops being covered if the app
is hosted for other people (their requests would go through someone's
subscription), if it reads or forwards tokens, or if it uses `--bare` (which
ignores subscription login and needs an API key). This is a reading of the
documentation, not legal advice; Anthropic may enforce without notice, and a
written confirmation is the only certainty for borderline cases (solution E).

## 4. The solutions

### A. Current method, improved

**How it works today.** The server spawns one `claude -p` per prompt with stdin
closed (`runPrompt`, `server/server.js`). On a `permission_denied` marker the
front end aborts the CLI and shows the popup (`handleIfPermissionDenied`,
`front/index.js`); granting resumes the session with `--resume <id>
--allowed-tools <Tool>` and the hidden prompt `continue`
(`resumeWithToolAllowed`). `permission_denials` at the end of the run is the
fallback (`handleDeniedAtEnd`).

**Done (2026-10-17): scoped rules.** "Always allow" is offered scoped
(`Bash(<first word> *)`, `Edit(<folder of the file>/**)`) and for the whole
tool; "Allow once" grants a rule for exactly the denied action
(`Bash(<command>)`, `Edit(<file>)`), the bare tool name only for other
tools. Rules are built in `front/permissionRules.js` and passed one per
argument after `--allowed-tools`.

**Kept as is: the `continue` resume.** An explicit prompt ("The <Tool> tool is
now allowed for the action that was denied. Do that action again now, then
carry on with the task.") was compared with `continue`, 4 `haiku` runs each,
reproducing the app's flow (CLI killed at the marker, then `--resume` with an
`Edit(<file>)` rule) *(2026-10-17)*: the file was created 4 times out of 4
both ways. The explicit prompt redid the denied action directly every time;
once, `continue` first tried another tool (PowerShell, denied) before
`Write`. The old "Done" without a tool call was not seen again. Not worth the
change (the history filter would also have to know the new prompt); B makes
the resume unnecessary anyway.

**Not done.** Show `decision_reason` in the popup: absent from an ordinary
`-p` denial, useful with B only.

- **Strengths.** Already built and working; documented options only; no
  waiting process; works in every mode, `dontAsk` included.
- **Weaknesses.** The model is cut and must redo the action on its own: with a
  bare `continue` it once answered "Done" without calling the tool. Every grant
  costs a kill, a restart and a context reload, and leaves CLI filler
  ("No response requested."). Denying ends the turn: the user cannot tell the
  model what to do instead. No structured questions, no plan approval.
- **Licensing.** Covered.
- **Difficulty.** Small (front end only).
- **Tests done.** Marker detection replayed on real captured streams for
  `Write`, `Edit`, `Bash`, `dontAsk` (2026-10-06). `--allowed-tools
  "Bash(node *)"` passed at launch lets `node` run without a request while
  `mkdir` still asks *(tested 2026-10-17, through the hook spike)*.
  Rules at launch, without any hook, `haiku`, Windows, 10 runs
  *(2026-10-17)*:
  - `Bash(node *)` lets `node --version` run. For `node --version && git
    --version` the CLI splits the command and denies with "This Bash command
    contains multiple operations. The following part requires approval: git
    --version": the app builds its rules from that part.
  - `Bash(node -e "console.log((1+1))")`, the exact command with quotes and
    parentheses, matches.
  - `Edit(...)` rules cover `Write`. Relative `Edit(sub/**)` works. For an
    absolute Windows path, `//c/Users/...` (lowercase drive, no colon) and
    `C:/Users/...` work; the documented `//C:/Users/...` and `/C:/...` never
    match. The app uses `//c/...`. `Edit(//c/.../sub/**)` does not allow a
    write next to `sub`.
  - Several rules as separate arguments after `--allowed-tools` work.
  - PowerShell (4 runs): `PowerShell(Get-Date -Format yyyy)`, the exact
    command, matches. `PowerShell(Get-Date *)` never did, not even for the
    plain command: the CLI first parses the command with `pwsh`, and with the
    Microsoft Store `pwsh` (7.6.7, `WindowsApps` alias) on this machine that
    parse fails, the denial reading "Command contains malformed syntax that
    cannot be parsed: pwsh exited with code 1: La ligne de commande est trop
    longue". The app therefore offers PowerShell an exact "once" rule and the
    whole tool, no prefix rule. To retry with a `pwsh` installed from the MSI.
- **Tests to do.** Explicit resume prompt against `continue`, several runs
  each; whether `--allowed-tools` unblocks a tool in `dontAsk`; folder names
  containing parentheses in an `Edit` rule; the scoped popup with JAWS.

### B. `PermissionRequest` hook of type `http`

**How it works.** Each spawn gets `--settings` with a `PermissionRequest` hook
pointing at a ClaudeAccess route, e.g.
`{"hooks":{"PermissionRequest":[{"hooks":[{"type":"http","url":"http://localhost:1080/hook/permission/<runId>","timeout":3600}]}]}}`.
When the CLI is about to ask (or would auto-deny), it POSTs `tool_name`,
`tool_input`, `permission_mode`, `permission_suggestions`, `session_id`, `cwd`
(no `tool_use_id`) and **waits**. The server forwards the request over the
WebSocket and answers with
`{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{…}}}`:
`allow` (optionally `updatedInput`, `updatedPermissions`) or `deny`
(optionally `message`, `interrupt`).

- **Strengths.** Fully documented. The CLI itself decides that a permission is
  needed, so no false alarm and no missed request. The tool runs in the same
  turn as soon as the user agrees: no cut, no `continue`, no dependence on the
  model redoing the action, and the model never sees a denial it could try to
  work around. Deny with a message the model reads. Scoped "always" rules.
  Allow with a modified input. Small change to the architecture (still one
  spawn per prompt). Today's mechanism stays as the fallback.
- **Weaknesses.** No structured questions and no plan approval (no host).
  The wait is live: when the hook times out (default 600 s, configurable), the
  server restarts or the connection fails, there is no decision and the CLI
  denies, so the fallback takes over. A `session` rule only lives as long as the
  process, i.e. one message: the app must remember "always" rules and pass them
  as `--allowed-tools` on every spawn. The CLI's own suggestions are rarely the
  scoped rule wanted (see tests). Does nothing in `dontAsk`. The route has to
  be protected (unguessable run id) since the server has no authentication.
- **Licensing.** Covered (documented hook, unmodified binary, credentials
  untouched).
- **Difficulty.** Medium: one held-open route and a pending-request table on
  the server, a new trigger for the existing popup, mock support.
- **Tests done** *(2026-10-17, CLI 2.1.286, `haiku`, `default` mode unless
  stated)*:
  - The hook passed through `--settings` fires in `-p`, to `127.0.0.1`, as soon
    as the `tool_use` appears in the stream.
  - Allow: the file is written in the same turn, no `permission_denied`.
  - Deny with a message: the model reads it and complies. The CLI still emits
    `permission_denied` (with `decision_reason_type: "hook"`) and a
    `permission_denials` entry: **the app must ignore denials it decided
    itself**, otherwise the popup reopens.
  - Deny with `interrupt: true`: the run ends with `error_during_execution`,
    exit code 1, no final text; marker also tagged `hook`. Usable for "Abort"
    while a question is open.
  - HTTP 500 from the hook: no decision, ordinary denial ("you haven't granted
    it yet"), no `decision_reason_type`: the current fallback handles it.
  - 90-second wait before answering: the CLI waited and then ran the tool.
  - Two `Write` calls in parallel: the second request arrives only after the
    first is answered; no queue needed on our side.
  - `updatedPermissions` with `addRules` `Bash` / `node *` / `session`: the
    second `node` command in the same run did not ask again.
  - The same rule re-sent at launch as `--allowed-tools "Bash(node *)"`: only
    the `mkdir` call asked.
  - `acceptEdits` and a write outside the workspace: the hook is called (mode
    `acceptEdits`), allow writes the file.
  - `dontAsk`: the hook is never called; the model then tried PowerShell as a
    workaround, also denied.
  - `plan` mode: the hook is not called; the model refused to write the file
    and wrote a plan into `~/.claude/plans/`.
  - `updatedInput`: the file got the content replaced by the hook.
  - Suggestions actually received: `Write` → `setMode acceptEdits`
    (`session`); `mkdir` → `addDirectories` + `setMode acceptEdits`;
    `node -e …` → `addRules` on the **exact** command, destination
    `localSettings` (would be written to the workspace's
    `.claude/settings.local.json` if echoed as is).
- **Tests to do.** A wait close to the configured timeout, and what happens
  when it expires; server restart and browser tab closed while a request is
  pending; abort (kill) during a pending request; behaviour with `--resume`
  and `--fork-session`; `auto` and `bypassPermissions` modes; MCP tools;
  requests raised inside a subagent; the popup with JAWS. (Scoped `Edit` path
  rules: see A.)

### C. `PreToolUse` hook returning `defer`

**How it works.** A `PreToolUse` hook (called before every tool call, before
rules and mode) answers `permissionDecision: "defer"`. The CLI stops with
`stop_reason: "tool_deferred"` and `deferred_tool_use` (`id`, `name`, `input`);
the call stays pending in the session file. The app asks the user, then runs
`claude -p --resume <id>`: the same call is replayed, the hook fires again and
answers `allow` (with `updatedInput`) or `deny`. The doc presents it as meant
for "a custom UI built on top of Claude Code".

- **Strengths.** Documented. The replay is exact: the very same call runs, no
  reliance on the model. No time limit: the request survives a closed browser,
  a server restart, a reboot (session files are kept 30 days by default). This
  is the property the future remote mode needs for reconnection.
- **Weaknesses.** The hook does not know whether the call would need a
  permission: the app would have to reimplement the CLI's decision (mode,
  read-only commands, workspace boundaries, protected paths), with false alarms
  and missed requests. Only works when the model makes a single tool call in
  the turn; otherwise `defer` is ignored and the call goes through the normal
  flow (denied in `-p`). A stop and a restart per question. "Always" rules must
  be handled by the app. `AskUserQuestion` and `ExitPlanMode` still need a
  permission host. On resume the permission mode must be passed again (the app
  already does).
- **Licensing.** Covered.
- **Difficulty.** Medium to high (the decision logic is the hard part).
- **Tests done.** None.
- **Tests to do.** Defer then resume on a single call; behaviour with two
  parallel calls; cost of the stop and restart; a combination with B (defer
  only when no browser is connected).

### D. MCP tool given to `--permission-prompt-tool`

**How it works.** A small local MCP server (stdio) exposes a tool that the CLI
calls for every permission prompt; the tool forwards to ClaudeAccess and
returns allow or deny once the user answered. That makes it a permission host.

- **Strengths.** Documented flag. A real host: the CLI waits, and
  `AskUserQuestion` and `ExitPlanMode` become available to the model, so
  structured questions and plan approval are possible. Resuming a session in
  plan mode with `-p` also requires a prompt tool.
- **Weaknesses.** The input and output contract of the prompt tool is not
  described in any page read: it has to be captured first. An MCP server has
  to be written, ideally without adding the MCP SDK as a dependency. The CLI
  waits for the MCP server to connect before the first turn (up to
  `MCP_TIMEOUT`, 30 s). An `allow` for an MCP tool marked
  `requiresUserInteraction` is converted to a deny. Still one spawn per prompt.
  With a prompt tool the CLI no longer emits `permission_denied` at all.
- **Licensing.** Covered (documented flag).
- **Difficulty.** High.
- **Tests done.** None.
- **Tests to do.** Capture the request and expected answer of the prompt tool;
  `AskUserQuestion` round trip (answers format: `questions` echoed plus
  `answers` keyed by question text, from the SDK docs); `ExitPlanMode`
  approval and mode switch; timeout behaviour.

### E. Stdio control protocol (the Agent SDK's own channel)

**How it works.** One long-lived process per session:
`claude -p --input-format stream-json --output-format stream-json --verbose
--permission-prompt-tool stdio …`. User messages are written to stdin; the CLI
sends `control_request` messages (`{type, request_id, request}`, with a
`can_use_tool` request carrying the tool, its input, suggestions and decision
reason) and waits for a `control_response`. Other requests: `initialize`,
`interrupt` (with `cancel_queued`), permission mode changes.

- **Strengths.** Everything at once: the CLI waits in place, structured
  questions, plan approval, interrupt without killing, mode changes during a
  session, queued messages, faster turns (no respawn). It is what the SDK
  itself does, and the SDK reference describes the envelope and even mentions
  "a client that drives the CLI's control protocol directly".
- **Weaknesses.** The way to start the CLI as a stdio host
  (`--permission-prompt-tool stdio`) and the full request and response shapes
  are not documented for direct use; field names come from the SDK's types and
  third-party write-ups. Can change with any CLI update. Largest rewrite: a
  persistent child per connection, stdin protocol, mock rewrite.
- **Licensing.** Same unmodified binary and no credential handling, but it is
  the SDK's internal channel: the least clearly covered case for a
  subscription. Ask Anthropic before relying on it for a public release.
- **Difficulty.** High.
- **Tests done.** None. The installed CLI advertises in `system/init`:
  `interrupt_receipt_v1`, `interrupt_cancel_queued_v1`, `msg_lifecycle_v1`
  among its `capabilities`.
- **Tests to do.** Start flags and whether `initialize` is required; exact
  `can_use_tool` request and answer; `AskUserQuestion` and `ExitPlanMode`;
  `interrupt`; mode change; two messages in one process; `--resume` and
  `--fork-session` with stdin input.

### Not retained: the Agent SDK packages

`@anthropic-ai/claude-agent-sdk` (TypeScript) or `claude-agent-sdk` (Python)
give all of E with types and a documented `canUseTool` callback, but products
built on them must use an API key (section 3).

## 5. Comparison

| | A. Current improved | B. HTTP hook | C. Defer | D. MCP prompt tool | E. Stdio protocol |
|---|---|---|---|---|---|
| Documented | yes | **fully** | yes | flag only | partly |
| CLI waits for the answer | no | **yes** | no (stops, resumes) | yes | yes |
| Who detects a request | CLI marker | **CLI** | the app (approximate) | CLI | CLI |
| Reliability after a grant | depends on the model | **direct** | direct (replay) | direct | direct |
| Scoped "always" | built by the app | yes | built by the app | yes | yes |
| Deny with a message | no | yes | yes | yes | yes |
| Survives a disconnection | yes | no (falls back) | **yes** | no | no |
| Structured questions, plan approval | no | no | no | yes | yes |
| Interrupt without kill, persistent process | no | no | no | no | yes |
| Licensing (subscription) | covered | covered | covered | covered | least clear |
| Difficulty | small | medium | medium-high | high | high |
| Tested | partly | **yes** | no | no | no |

## 6. Best choice

**For ClaudeAccess.** A's small fixes now, then B as the main mechanism, with
today's flow kept as the fallback (hook failure, `dontAsk`, older CLI).
Decisions that follow from the tests: ignore `permission_denied` messages
tagged `decision_reason_type: "hook"`; build scoped "always" rules in the app
and pass them as `--allowed-tools` on every spawn rather than echoing the CLI's
suggestions; use `deny` + `interrupt` for Abort while a question is open.
Add D or E later only if structured questions and plan approval become
wanted, after a spike, and for E with Anthropic's confirmation if the app is
ever published.

**For a similar app started from scratch.**
- On a Claude subscription (the case of a personal accessibility front end):
  build around B from day one, behind a small "permission channel" interface so
  that D or E can replace it later; run one `claude -p` per prompt, never host
  it for other people, never use `--bare`.
- With an API key acceptable: use the Agent SDK in streaming input mode. It
  gives the documented `canUseTool` callback (permissions, `AskUserQuestion`,
  plan approval), `interrupt()`, `setPermissionMode()` and typed messages, i.e.
  E without the undocumented parts.

## 7. Settled points (moved from `open-questions.md`)

- **Detection of a permission request.** Settled 2026-10-06: by the CLI's
  `system/permission_denied` marker, not by wording; ordinary tool errors
  ("String to replace not found", "File has been modified since read") carry
  no marker, are left to the model and no longer abort the run;
  `permission_denials` at the end of the run is the fallback; no popup for a
  tool already allowed (an error is shown instead, which also covers protected
  paths such as `.claude/skills|agents|commands`, denied even in
  `bypassPermissions` on 2.1.123); "allow once" grants are cleared on every
  new prompt. The text patterns ("haven't granted it yet", "requires / needs
  approval") are gone. Origin: a session with 157 `continue` prompts and no
  real denial, caused by treating every tool error as a denial.
- **Real denial wordings** (kept for the record, no longer used): `Write` and
  `Edit`: "Claude requested permissions to write to <path>, but you haven't
  granted it yet."; `Bash`: "<cmd> in '<path>' needs approval…" or "This
  command requires approval"; `dontAsk`: "Permission to use <Tool> has been
  denied because Claude Code is running in don't ask mode. IMPORTANT: You
  *may* attempt to accomplish this action using other tools…", which invites
  workarounds (seen again on 2026-10-17 with PowerShell).
- **The CLI does not stop at a denial**: it runs one or two more turns and ends
  with `success`, `is_error: false`; a denied run cost 0.008 to 0.02 USD on
  `haiku` (2026-10-06).
- **Cutting at the marker rather than waiting for the end of the run**:
  cheaper (no extra turns) and avoids the model trying a workaround with an
  already allowed tool.
- **Resume behaviour**: `--resume <id>` keeps the session id; `--fork-session`
  creates a new one. `--permission-mode manual` is an alias of `default`.
- **`--permission-prompts host|none`** (seen in `--help`, documented): `host`
  sends prompts to the SDK host or prompt tool, `none` denies them and tells
  the model not to retry. Without a host, ClaudeAccess already gets the `none`
  behaviour, minus the "don't retry" hint.
- **How to make the CLI wait for the user**: settled by the 2026-10-17 tests:
  solution B works with the installed CLI (section 4.B). Option C of the old
  open question (stdio protocol) is now solution E.
- **Scoped rules are honoured** both from the hook (`updatedPermissions`) and
  from `--allowed-tools` at launch (section 4.B tests). What remains open is
  where "always" choices are kept (`open-questions.md`, section 1).
