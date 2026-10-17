# Open questions

Working notes: decisions not made yet, things left unverified, and ideas
parked for later. Each entry says where things stand and what the next step
is. When an entry is settled, move its outcome to `plan.md` (or the code, or
`claude-p-usage.md` for the way `claude -p` is driven) and delete it here.

Last updated: 2026-10-17.

## 1. Where "always allow" choices live

Settled and moved to `claude-p-usage.md` (sections 4.B, 6 and 7): how a
permission request is detected, the launch state of the "always allowed" list,
and the fact that scoped rules such as `Bash(node *)` are honoured, from a
`PermissionRequest` hook as well as from `--allowed-tools` at launch. Once
"Always allow" sends a scoped rule instead of the bare tool name, the widening
under "Accept edits" (a bare `Write` allow covering every path) goes away.

**Still open.**
- Where the choices live: page memory for the session (today), the server per
  session (next to the run options), or the workspace's
  `.claude/settings.local.json` (the CLI's own `localSettings` destination,
  which the terminal would then honour too).
- Showing the current list somewhere, beyond the line under the mode
  description.
- How the app builds the scoped rule from a request (command prefix, folder
  of a file): the CLI's suggestions are an exact command or a mode switch.

**Next step.** Decide while implementing solution B of `claude-p-usage.md`.

## 2. Progress line (first version done, details open)

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

## 3. One descriptor for tool use everywhere

`describeTool()` now serves the progress line and the permission popup.
`classifyToolUse` (collapsible tool details) and its server-side copy in
`server/history.js` still use their own logic. Decide whether the server
should return raw `tool_use` blocks and let the browser describe them, so
history, live details and progress share one rule. Parked on purpose: tool
details are informational only, not worth a risky change yet.

## 4. Permission mode descriptions

The one-line descriptions on the main page come from the Claude Code docs,
not from tests. Docs say `acceptEdits` also auto-approves `mkdir`, `touch`,
`rm`, `rmdir`, `mv`, `cp`, `sed` inside the working directory, which the
current French / English text only covers as "common file commands". `auto`
availability depends on model and account, and the docs say a session with no
explicit mode may start in auto: ClaudeAccess always passes
`--permission-mode`, so this does not apply, but check it stays true.

## 5. Two instances: ClaudeAccess (stable) and ClaudeDev (workbench)

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

## 6. Workspace list: leftovers

The list now lives in `~/.claude-access/workspaces.json` (see `plan.md`).
Still browser-side: only the "always allowed" tools (deliberately never
saved); the run options per session moved to the server (2026-10-08, see
`plan.md`). The legacy browser keys are left in place after migration and could be
cleaned up later. The migration only runs when the server has no list: opening
the app first from a browser with empty data creates an empty list.

## 7. "Send in a new branch" button

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