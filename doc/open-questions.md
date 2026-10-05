# Open questions

Working notes: decisions not made yet, things left unverified, and ideas
parked for later. Each entry says where things stand and what the next step
is. When an entry is settled, move its outcome to `plan.md` (or the code) and
delete it here.

Last updated: 2026-10-05.

## 1. How to tell a real permission request from an ordinary tool error

**Problem.** `handleIfToolDenied` (front/index.js) treats every `tool_result`
with `is_error: true` as a permission denial: it aborts the CLI and shows the
allow / always / deny popup. Ordinary `Edit` errors ("String to replace not
found", "File has been modified since read") trigger it too. Allowing then
resumes with the prompt `continue`, the same error comes back, and the popup
loops. Observed in one real session: 157 `continue` prompts, 159 CLI-written
`<synthetic>` "No response requested." messages, and no genuine permission
denial at all.

**What is known.**
- Real denial text, for `Write` (anthropics/claude-code issue 54850):
  "Claude requested permissions to **write to** <path>, but you haven't granted
  it yet." The mock says "to **use** X", which is a different wording. Only
  "you haven't granted it yet" is common to both. No real text found for
  `Edit`, `Bash`, MCP tools, `deny` rules, hooks, the auto-mode classifier or
  `dontAsk`.
- The final `result` message carries a `permission_denials` array (entries
  with `tool_name`, `tool_use_id`, `tool_input`). Without it a denied run ends
  with exit 0, `subtype: "success"`, `is_error: false`.
- Writes under `.claude/skills|agents|commands` were denied even in
  `bypassPermissions` on 2.1.123: allowing can never help there, so a loop
  guard is needed anyway.
- The documented live mechanism (Agent SDK `canUseTool`): the CLI started with
  `--permission-prompt-tool stdio --input-format stream-json
  --output-format stream-json --verbose` pauses and emits a `control_request`
  with `request.subtype: "can_use_tool"` (`request_id`, `tool_name`, `input`,
  `decision_reason`, `tool_use_id`). The host answers on stdin with a
  `control_response` (`behavior: "allow"` + `updatedInput`, or `"deny"` +
  `message`, which is required). Without `--permission-prompt-tool stdio`,
  non-interactive runs auto-deny. Field names come from third-party write-ups
  (one Go SDK doc shows a different shape, `permission`), not from a capture.

**Options.**
- A. Text filter on "you haven't granted it yet". Cheap, but a wording we have
  not seen would be missed silently.
- B. Confirm with `permission_denials` at the end of the run. Wording-proof,
  but late: the CLI keeps going without the tool, then needs a resume.
- C. Switch to the stdio control protocol. Only genuine requests ever reach
  the UI, no abort / resume / `continue`, no `<synthetic>` noise, and
  `decision_reason` can replace the "Error: ..." line. Cost: a rewrite of
  `runPrompt` (keep stdin open, send the prompt as JSON, relay requests over
  the WebSocket, update the mock).

**Cost of B (token estimate, nothing measured).** Today the CLI is cut as soon
as a denial shows up, then resumed with `continue`. B would let the run finish
first. Extra cost: the model sees the denial and keeps going for roughly 1 to
3 more API calls (it explains, or tries something else). Each call re-reads
the session context, mostly from cache (billed far below fresh input), plus a
few hundred output tokens. The resume after the user's answer costs the same
in A and B. The longer the session, the more each extra call weighs. The usage
the CLI reports per run is already recorded (`recordTokenUsage`), so it can be
measured on a real case.

The bigger drawback of B is behaviour, not tokens: after a refused `Write`,
the model may try a workaround such as writing the file through `Bash`. If
`Bash` is already "always allowed" that runs without a popup. Cutting early
avoids it. B also does nothing against the false alarms, which come from
mistaking ordinary errors for denials: not aborting on them costs no tokens.

**Compromise leaning.** (1) Abort at once when the error text contains "you
haven't granted it yet" (known case, cheapest). (2) Do not abort on any other
tool error; if `permission_denials` is non-empty at the end of the run, show
the popup then (rare unknown-wording case, so its extra cost is rare too).
(3) Option C removes all of this cost: the CLI waits in place.

**Status.** The compromise is implemented (details in `spec-interface.md`,
section 7, and `spec-server.md`, tool error log): genuine denials are
recognised by "you haven't granted it yet" and cut the CLI at once; other
tool errors are left to the model; `permission_denials` at the end of the run
is the fallback for unrecognised wording; no popup for an already-allowed
tool; "allow once" grants are cleared on every new prompt; every tool error
is logged to the server console to collect real wordings. Not yet exercised
against the real CLI. Option C (spike first) remains the end goal.

**Next step.** Capture a real request with `claude` on `haiku` + `low` in a
scratch directory: exact field names, behaviour with `--resume`, behaviour in
auto mode. Meanwhile, a minimal patch is possible: do not abort on errors that
are not denials, log every tool error to the server console, never prompt for a
tool already in `allowedTools`, and add a loop guard (same request twice, or a
`<synthetic>` reply right after a resume, means show the error instead).

## 2. Granularity of "always allow"

**Problem.** "Always allow" adds the bare tool name to `allowedTools` (kept in
page memory, re-sent as `--allowed-tools`). Allowing `Bash` therefore allows
every command, including `rm -rf` and `cp -r`: that is probably why a copy
and a recursive delete ran without a popup while the mode was `default`
(checked in the session file: `default` was active at the time, not
`bypassPermissions`). Not verified: whether `Bash` was actually in the list.

**Options.** Scoped rules the CLI already understands (`Bash(npm test *)`,
`Edit(path/**)`), or `permission_suggestions` echoed back under option C of
point 1. Also: show the current "always allowed" list somewhere, and decide
whether it lives for the session only or is persisted.

**Launch state of the list.** Decided and implemented: the list sent to the
CLI starts empty, is emptied on every change of permission mode and when a
session or workspace is opened, can grow during the session and is never
saved. Each mode has a known state per main tool (asks / allowed / denied /
checked, see `spec-interface.md` section 7), used only to show, under the mode
description, which tools the user allowed "always" beyond the mode. Those
states are deliberately not sent as `--allowed-tools`: a bare `Write` allow
would also approve writes outside the workspace under "Accept edits".

**Gap.** Allowing a tool the mode already allows (for example `Write` under
"Accept edits", after a denial for a path outside the workspace) shows no
change line but widens it to every path. Needs scoped rules (above) to be
expressed honestly.

**Status.** Launch state settled; granularity still undecided. Depends on
point 1.

## 3. Progress line (first version done, details open)

- Stream message shapes used for steps are from memory and unconfirmed:
  `system`/`init`, `thinking` and `text` blocks. A missing one leaves the line
  on "Claude is working...".
- Bash: show `command` (precise, what the popup needs) or `description`
  (friendlier)? Currently `command`.
- Flag external files on the progress line too, or only in the popup?
  Currently popup only.
- MCP tool names (`mcp__server__tool`) are shown raw. Shorten them for
  screen-reader output? Tool names are deliberately not translated.
- Tools with other parameter names (`NotebookEdit` uses `notebook_path`, now
  handled) and less common tools fall back to the tool name alone. Extend
  once real runs show which ones matter.
- Removed the "Working..." message from the status area when a prompt is sent,
  because the progress line and focus say it already. Confirm this is wanted.
- `progressAnnounce` is lost if the server was started before the key existed:
  its old `sanitize` drops unknown keys, so the checkbox saves nothing and
  reads back unchecked. Restart the server after config changes. Consider
  making the main page treat a missing value as "announce".

## 4. One descriptor for tool use everywhere

`describeTool()` now serves the progress line and the permission popup.
`classifyToolUse` (collapsible tool details) and its server-side copy in
`server/history.js` still use their own logic. Decide whether the server
should return raw `tool_use` blocks and let the browser describe them, so
history, live details and progress share one rule. Parked on purpose: tool
details are informational only, not worth a risky change yet.

## 5. Permission mode descriptions

The one-line descriptions on the main page come from the Claude Code docs,
not from tests. Docs say `acceptEdits` also auto-approves `mkdir`, `touch`,
`rm`, `rmdir`, `mv`, `cp`, `sed` inside the working directory, which the
current French / English text only covers as "common file commands". `auto`
availability depends on model and account, and the docs say a session with no
explicit mode may start in auto: ClaudeAccess always passes
`--permission-mode`, so this does not apply, but check it stays true.

## 6. Two instances: ClaudeAccess (stable) and ClaudeDev (workbench)

`ClaudeDev` is a folder copy (renamed, port 1081, config dir `~/.claude-dev`,
launcher `start-claudedev.bat`), without any git files by choice, to rule out
pushing to the wrong repository. It is a snapshot taken before the
server-side workspace list, the "existing workspaces" picker, the run options
read from session files and the hidden `<synthetic>` / `continue` messages:
none of that is in ClaudeDev.

Open:
- How to carry changes between the two now that they share no history.
  Candidates: use ClaudeDev as the workspace that edits ClaudeAccess, with a
  `git worktree` of ClaudeAccess on a separate branch.
- Port and config directory are hard-coded per copy. A shared codebase would
  need environment variables (for example `CLAUDEACCESS_PORT` and
  `CLAUDEACCESS_CONFIG_DIR`); not implemented.
- ClaudeDev starts with default settings: `~/.claude-access/config.json` was
  not copied. Its workspace list (browser side in that copy) starts empty.
- `package.json` still points `repository.url` to the original repository.
- ClaudeDev still has `plan.md` at its root; ClaudeAccess moved it to `doc/`.

## 7. Workspace list: leftovers

The list now lives in `~/.claude-access/workspaces.json` (see `plan.md`).
Still browser-side: the run options remembered per session (a fallback only,
the session file wins) and the "always allowed" tools (deliberately never
saved). The legacy browser keys are left in place after migration and could be
cleaned up later. The migration only runs when the server has no list: opening
the app first from a browser with empty data creates an empty list.
