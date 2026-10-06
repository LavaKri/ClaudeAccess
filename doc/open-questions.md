# Open questions

Working notes: decisions not made yet, things left unverified, and ideas
parked for later. Each entry says where things stand and what the next step
is. When an entry is settled, move its outcome to `plan.md` (or the code) and
delete it here.

Last updated: 2026-10-06.

## 1. How to tell a real permission request from an ordinary tool error

**Problem.** `handleIfToolDenied` (front/index.js) treats every `tool_result`
with `is_error: true` as a permission denial: it aborts the CLI and shows the
allow / always / deny popup. Ordinary `Edit` errors ("String to replace not
found", "File has been modified since read") trigger it too. Allowing then
resumes with the prompt `continue`, the same error comes back, and the popup
loops. Observed in one real session: 157 `continue` prompts, 159 CLI-written
`<synthetic>` "No response requested." messages, and no genuine permission
denial at all.

**Found 2026-10-06.** The filter first only knew "you haven't granted it
yet", so genuine `Bash` denials ("This command requires approval", "This Bash
command contains multiple operations. The following part requires approval:
…", about 18 error results in one session file) opened no popup and the user
never saw a request. The pattern now also matches "requires approval" and
"needs approval" (a third wording, seen on a `mkdir` outside the working
directories: "mkdir in '<path>' needs approval. The path is outside the
working directories for this session. Allowing runs the command as
written."). Other
wordings may exist (a "Contains simple_expansion" result was seen once for a
heredoc command): the server console log and the end-of-run fallback exist to
catch them.

**Real CLI runs, 2026-10-06** (`haiku`, effort low, scratch directory, mode
`default`/`manual`/`dontAsk`; raw streams were kept under `Temp\ca-real\out`
until cleaned up).
- **Wordings, now seen for real.** `Write` *and* `Edit`: "Claude requested
  permissions to write to <path>, but you haven't granted it yet." (the mock's
  "to use X" was wrong). `Bash`: "mkdir in '<path>' needs approval. The path
  is inside the working directories…" (a read-only compound command such as
  `echo one && echo two` ran without any approval in `default`). `dontAsk`:
  "Permission to use Write has been denied because Claude Code is running in
  don't ask mode. IMPORTANT: You *may* attempt to accomplish this action using
  other tools…" — it matches none of the three patterns, and it nudges the
  model towards workarounds.
- **A structured marker exists.** Right before every denied `tool_result` the
  CLI emits `{ type: "system", subtype: "permission_denied", tool_name,
  tool_use_id, message }` (seen for `Write`, `Edit`, `Bash` and in `dontAsk`),
  and the final result lists the denial in `permission_denials` (`tool_name`,
  `tool_use_id`, `tool_input`). Detecting denials with this message needs no
  wording at all and would also cover `dontAsk`. **Not implemented yet**:
  detection still relies on the text patterns plus the end-of-run fallback.
- **The CLI does not stop at a denial.** It runs 1 or 2 more turns (the model
  asks for permission in plain text) and ends with `success`, `is_error:
  false`. A denied run cost about 0.008 to 0.02 USD on `haiku`.
- **Resume reliability.** `--resume <id> --allowed-tools Write` with the prompt
  `continue` reuses the same session id (`--fork-session` is what would create
  a new one). In one run the model retried the `Write` and succeeded; in
  another it answered "Done! The file has been created" **without calling the
  tool** and the file did not exist. A bare `continue` is not a reliable way
  to make the model redo the denied action. To test: an explicit resume prompt
  (for example "The <Tool> tool is now allowed, please redo the action that
  was denied") against `continue`, several runs each.
- **Options.** `--permission-mode` accepts `default` and `manual` (an alias;
  the init message reports `default` in both cases). `--permission-prompts
  host|none` and `--include-partial-messages` exist.
- **Stream shape.** `system/init`, `system/thinking_tokens` (estimated tokens,
  sent while the model thinks), one assistant message per block (`thinking`
  with empty text, `tool_use`, `text`), `user` with the `tool_result`,
  `rate_limit_event`, then `result`. Thinking blocks do appear.
- **Not run:** token measurement per approach, `Write` outside the workspace
  under "Accept edits", whether `--allowed-tools` unblocks a tool in `dontAsk`,
  the stdio control protocol.

**What was known before these runs.**
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
- D. Choose who answers with `--permission-prompts host|none` (`--help`, CLI
  2.1.286; default `host`). `host` hands every would-be prompt to the process
  driving `claude -p` (the SDK host or `--permission-prompt-tool`): that is the
  stdio channel of option C. `none` makes anything that would prompt an
  automatic denial, the permission mode still deciding the rest: that is what
  we get today. Idea: send `host` for runs where the UI can answer, `none` for
  runs that must never wait (for example a future batch or scheduled mode).
  Not tested: whether `host` without `--permission-prompt-tool stdio` behaves
  like `none` or hangs, and whether the flag changes the shape of the
  `control_request` messages.

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

**Status (2026-10-06).** Denials are now recognised by the CLI's own
`system/permission_denied` marker instead of by wording (details in
`spec-interface.md`, section 7, and `spec-server.md`, tool error log): the
marker cuts the CLI at once and opens the popup; other tool errors are left
to the model; `permission_denials` at the end of the run is the fallback for a
CLI without the marker; no popup for an already-allowed tool; "allow once"
grants are cleared on every new prompt; while a question is open whatever the
cut CLI still sends is ignored; every tool error is logged to the server
console. The text patterns ("haven't granted it yet", "requires / needs
approval") that did the job until then are gone, which also fixes `dontAsk`,
whose wording matched none of them. Exercised on 2026-10-06: by hand with the
real CLI for `Bash` (popup, "Allow once", "Always allow" and its change line)
under the old text patterns; the marker itself was replayed offline on the
real captured streams for `Write`, `Edit`, `Bash` and `dontAsk`, and on made-up
cases (made-up wording, already-allowed tool, two denials in a row). Not yet
tried by hand in the browser with the marker. Option C (spike first) remains
the end goal.

**Open after the real runs.** The reliability of `continue` as the resume
prompt (see "Resume reliability" above) and whether `--allowed-tools` really
unblocks a tool in `dontAsk` mode.

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

**Gap, partly handled.** Under "Accept edits", `Write` and `Edit` are allowed
only inside the workspace, so a popup there means a path outside it. The
change line now says so ("Write (the mode allows it only inside the
workspace)"). The widening itself remains: an "always allow" of a bare tool
name covers every path. Reducing it needs scoped rules (above).

**Status.** Launch state settled; granularity still undecided. Depends on
point 1.

## 3. Progress line (first version done, details open)

- Stream message shapes used for steps are now confirmed on real runs
  (`system`/`init`, `thinking` and `text` blocks, `system/thinking_tokens`);
  replaying captured streams through the progress logic gave the expected
  sequences. The thinking text is empty, so "Claude is thinking" is driven by
  `thinking_tokens` (sent while the model thinks) rather than by the block.
- Bash is shown with `command`; the real CLI also sends a ready-made
  `description` ("Create a new directory named newdir"), which stays an
  option for the progress line only.
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

## 8. "Send in a new branch" button

**Idea.** A second button next to "Send" that sends the prompt in a new branch
of the current session, keeping the original session untouched.

**Checked on 2026-10-06** with the real CLI (2.1.286, `haiku`, scratch
directory). `--resume <A> --fork-session` answers with the full context of A
(it recalled a word given in A), reports a new `session_id` B in the stream
and writes a separate `B.jsonl` holding the copied history. Resuming A
afterwards (without the flag) works, still reports A and does not contain the
forked turn. The forked turn cost the same as a normal one, with the prompt
cache re-used (about 24,700 tokens read from cache). Not tried: how the
history loader and the session list display B in the interface.

**Status (2026-10-07): implemented**, "Send to a new branch" (fr: "Envoyer vers
une nouvelle branche"), see `spec-interface.md` section 5 and
`spec-server.md`. Decisions: the branch is named "From <title of the
original>" (set at the end of its first turn, through the existing rename
route); the current run options are copied to it; no screen reader
announcement; the button is enabled and disabled together with Send, and acts
like Send when there is no session yet. Checked offline with the mock (new
session id with the flag, same id without) and the CLI behaviour above; not
yet tried by hand in the browser.

**Still open.**
- Parent link: B's file holds no reference to A (no `forkedFrom` or similar
  found). Showing a tree of branches would need the link kept by the server.
- A branch aborted before its first result stays untitled until a later turn
  ends in it (the title is only written once a result arrives, because
  writing it earlier would create the session file).
- Session list de-duplication (`listSessions`, by subset of message ids): a
  branch with a new model message has more ids than the original, so both are
  listed. A branch with no model message yet (aborted early) has exactly the
  original's ids and is dropped, or replaces it, depending on file order. Not
  tried by hand.
- Permission resume inside a branch uses plain `--resume B`, no fork flag
  (so every resume does not create yet another branch); not tried by hand.

## Tasklist
In the official interface you can view a tasklist. 
Create a file or a pop-up to see tasks ?