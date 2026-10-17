# Interface specification

What the web interface does today, from the user's side. For the server see
`spec-server.md`; for the history of decisions see `plan.md`; for what is
still undecided see `open-questions.md`.

Plain HTML, CSS and ES modules in `front/`, no framework. Accessibility with
the JAWS screen reader is a first-class constraint: dynamic content uses
`aria-live` regions deliberately, focus is managed on purpose, and content a
screen reader is reading is not re-rendered destructively.

Last updated: 2026-10-05.

## 1. Page layout (source order = reading order)

1. Link to the options page.
2. Run options: model, effort, permission mode, with a one-line description of
   what the selected permission mode allows, asks or denies (linked to the
   select with `aria-describedby`; main page only). A second line, present
   only when needed, says which tools the user allowed "always" beyond what
   the mode does (see section 7).
3. Sidebar column: the **workspaces** section, then the **sessions** section.
4. Main column: session title (H2), status area (`role="status"`,
   `aria-live="polite"`), session options menu, token usage,
   message pagination, message log, the question dialog, the prompt form, and the
   **Progress** region at the very bottom of the page.

Two-column grid on wide screens, single column on narrow ones.

## 2. Workspaces

The list is the user's own, kept on the server (`workspaces.json`), in the
order entries were added, paginated with Newer / Older buttons.

- Choosing a workspace makes it current and opens the session it was
  last on (the most recent one if that is unknown or gone); with no sessions
  the conversation stays empty. The model, effort and permission
  mode are those of the opened session (section 8).
- **Add a workspace…**: dialog with a path field and a native folder picker
  (a picked folder validates the dialog at once). A path already in the list
  just switches to it (comparison ignores case, slash style and trailing
  separator).
- **Existing workspaces…**: lists the folders Claude Code has history for that
  aren't in the list; choosing one adds it. Nothing is added automatically.
- Per-workspace menu: **Rename** (custom name, stored with the entry),
  **Remove from list** (drops the entry only, history untouched, status
  message confirms), **Delete** (confirm dialog, then deletes the history on
  disk too). Removing or deleting the current workspace resets the view.
- Buttons are labelled with the last path segment (or the custom name); the
  full path is the tooltip.
- Migration: when the server has no list yet, the first load builds it from
  what the browser used to keep (known folders plus manually added, minus
  hidden, custom names, last workspace and session). The old localStorage keys
  are left in place, unused.

## 3. Sessions

Listed newest first for the current workspace, paginated. Each session button
reads "<title>, <date of the last message>, <N> messages". N counts the
messages its log would show: tool uses are left out, and so are the hidden
messages (section 4) unless "Show hidden messages" is on. The plural follows
the interface language ("0 message" in French, "0 messages" in English).

- **New session**, **Refresh sessions**, choose one to open it (the last page
  of its messages is shown).
- Per-session menu: rename, delete (confirm). Duplicate and move were removed
  (2026-10-06): both manipulate files the CLI owns, duplicate hid one of the
  two copies in the list, and move relied on an unverified assumption about
  `--resume`. To continue elsewhere, start a new session in the right
  workspace.
- Session options menu (current session): rename, copy the whole session as
  Markdown, export it as a Markdown file.
- Opening a session restores the model, effort and permission mode it was last
  run with, read from the session file (so any browser reopens it the same
  way); this browser's own memory fills in what the file lacks, then the
  defaults. The "always allowed" tools start empty.
- The workspace's last opened session is remembered with the entry and
  reopened at startup.
- Title: custom title, else the AI title, else the start of the last reply.

## 4. Messages

- Grouped by speaker: each group is one H2 followed by one paragraph per
  message, so heading navigation moves between turns. Claude's replies are
  rendered from Markdown through a safe renderer (model text is never trusted
  as markup) and headed with the model and effort used.
- Tool uses are collapsed into a details/summary and don't count as a page
  slot.
- Pagination: first / previous / page select / next / last, over
  `messagesPerPage` groups. The page picker is a select, not a number input,
  so JAWS's "next edit field" key goes straight to the prompt.
  Previous / next are also bound to Alt+Page Up / Alt+Page Down. Previous
  moves the focus to the heading of the last message group of the new page,
  next to the first one. After a run or when opening a session the view
  follows the last page; a user reading an earlier page is left alone.
- Closing any pop-up puts the focus back on the element that had it before the
  pop-up opened. If that element is gone or disabled by then (e.g. the Send
  button once a run has started), the focus is left where it is.
- Per-group menu: copy.
- Noise hidden, in the rebuilt history and in the live log alike: replies
  whose text is exactly "No response requested." (whichever model wrote them,
  `<synthetic>` included), empty texts, and bare "continue" prompts. A turn
  whose only reply is that filler produces no log entry and no sound. The
  option "Show hidden messages" brings back the filler replies and the
  "continue" prompts (including the silent ones sent after a permission
  grant), with no particular marking; a filler turn is then an ordinary turn
  (log entry, status, sound). Empty texts stay hidden. Takes effect when the
  main page is loaded.
- **Synthetic messages are not hidden as a class.** `<synthetic>` is the
  placeholder model of messages the CLI writes itself. Besides the filler,
  some say something the user needs, such as "You've hit your session limit ·
  resets 2:10pm (Europe/Paris)". Hiding every `<synthetic>` message (done
  from 2026-10-05 to 2026-10-06) hid those too, so a message answered by the
  usage-limit notice looked like it had no answer, even after a page reload.
  These messages are now shown like any other text, but without a model name
  or effort level in the heading (there is none), so the heading reads
  "Claude replied: …" rather than "Reply from <synthetic>".
- **Live log = rebuilt history.** Every `text` the model writes is added to the
  log as soon as its assistant message arrives, between tool calls included;
  the final result then adds its text only if it differs from the last one
  shown (an identical repeat is dropped), and an empty result adds nothing.
  Before 2026-10-06 only the result's text was shown, so a turn ending on a
  tool call displayed an answer with no text, and the intermediate texts only
  appeared after a page reload. The "Refresh sessions" button reloads the
  session list, not the open conversation.

## 5. Prompt and run

- The prompt field sends with **Ctrl+Enter** or the Send button. While a run is
  in progress the field is read-only, Send is disabled and Abort is enabled.
- Keyboard shortcuts are written in the button names (e.g. "Send
  (Ctrl+Enter)", "Next page (Alt+Page Down)") and deliberately not in
  `aria-keyshortcuts`: its values must be English key names, so JAWS would
  announce each shortcut a second time, in English.
- **Send with low effort** sits right after Send (shortcut **Shift+Enter** in
  the prompt field) and is enabled and disabled with it. It sends exactly like
  Send, but the run uses the `low` effort. The effort select is not changed,
  and neither are the run options saved for the session. The override also
  applies to the silent "continue" retries after a permission grant in that
  run, and the response heading shows the low effort that was used.
- **Send to a new branch** sits next to Send and is enabled and disabled
  together with it. It sends the prompt with `--fork-session`: the current
  session stays as it was, and the conversation continues in a copy. The copy
  is named "From <title of the original>" (set once its first turn has ended,
  not when the run was aborted) and gets the current run options. There is no
  screen reader announcement; the session title and the session list show the
  switch. With no session yet there is nothing to branch from and the button
  behaves like Send. Ctrl+Enter is still a plain send.
- After sending, focus moves from the Send button to the **progress line**
  (rather than the "Prompt" region), and its text is written without a live
  announcement because focus already reads it.
- At the end of a response: status message, optional completion sound, the
  reply is appended, token usage is added up, the title is fetched shortly
  after for a new session, and a suggested next prompt (if any) fills the
  field.

## 6. Progress region

A plain `<div id="progressArea">` holding one paragraph, `<p id="progressLine"
tabindex="-1">`, with one line of text. `aria-live` is set on the div by the
code, not in the HTML.

**Why a plain `<div>` and not a named region.** The first version was a
`role="region"` with an `aria-label`. Each time the line was read, JAWS
announced "entering region Progress" and "leaving region", which is noise for
a single line of text. Without the role and the label there are no region
boundaries to announce; the user tried it on 2026-10-06 and found it much more
pleasant. What is given up: the region shortcut of the screen reader and the
accessible name, which doesn't matter here because the zone sits at the very
bottom of the page and receives focus after each prompt. `aria-live` doesn't
need a role, so the announcements and the "announce progress steps" option are
unaffected.

**Remark on `role="status"`.** Putting `role="status"` on the paragraph itself
would keep an accessible name without the region chatter, but a status is an
implicit, permanent polite live region: the option that turns announcements
off could no longer silence it. That is why the paragraph has no role and the
live behaviour is driven by `aria-live` on the div.

- Idle: "Waiting for a prompt". Working: "Claude is working…" (the default
  state, not a stream event).
- Steps taken from the stream, all confirmed on real runs: `system/init`
  ("Starting"); `system/thinking_tokens` and `thinking` blocks ("Claude is
  thinking"; the tokens message arrives while the model is still thinking);
  a `text` block ("Claude is writing the reply"); a `tool_use` block as
  `<Tool> <text>` (tool names are never translated; the text is the main
  parameter, cut at 80 characters); then the matching `tool_result` as
  `<Tool> done` or `<Tool>: error`. While a permission question is open:
  "Waiting for permission".
- Messages arrive once complete (the CLI doesn't stream partial text unless
  asked to), so a step shows when its block is finished, apart from thinking.
- A line identical to the one already shown is not rewritten, so repeated
  steps (a stream of thinking counters) don't trigger repeated announcements.
- Option "Announce progress steps with the screen reader" (on by default):
  turns `aria-live="polite"` on the region on or off; the line is always
  readable by navigating to it.

## 7. Tool permissions

The CLI cannot pause for approval in `-p` mode, so the interface handles it.

**What counts as a permission request**
- The CLI's own marker: right before the error `tool_result` of every denied
  tool it emits `{ type: "system", subtype: "permission_denied", tool_name,
  tool_use_id, message }`. On that message the CLI is cut at once and the
  popup shown, with the tool's input taken from the earlier `tool_use` and the
  marker's `message` as the last line. No wording is involved: the marker was
  seen on real runs for `Write`, `Edit`, `Bash` and in `dontAsk` mode, where
  the texts differ ("Claude requested permissions to write to … but you haven't
  granted it yet.", "mkdir in '…' needs approval…", "Permission to use Write
  has been denied because Claude Code is running in don't ask mode…"). Until
  2026-10-06 the detection matched those texts instead, which missed the
  `dontAsk` one.
- Any other tool error ("String to replace not found", "File has been
  modified since read"…) carries no such marker: nothing is cut, no popup, the
  model corrects itself; the progress line says "<Tool>: error".
- Fallback, for a CLI that doesn't send the marker: at the end of a run, the
  entries of the result's `permission_denials` (`tool_name`, `tool_use_id`,
  `tool_input`) get the popup then ("Denial reported at the end of the run").
- While a question is open, whatever the cut CLI still sends (the denied
  `tool_result`, a second denial in the same step) is ignored, so it can't
  replace the question or rewrite the progress line.
- A denial for an action already granted (its exact rule or the whole tool,
  always or for this run) gets no popup, since allowing again can't help
  (protected path, deny rule): an error is added to the log instead. A broader
  rule that didn't cover it (`Bash(npm *)` for a `git` command) still asks.

**The popup**: line 1 "Claude wants to use the `<Tool>` tool"; line 2 the
tool's main parameter (a file shown relative to the workspace, or its full path
when outside it; a command; a search pattern; a URL…); a warning line when the
file is outside the workspace (the path starts with a drive letter or
separator); a last line with the raw CLI error text. Buttons, built in
`front/permissionRules.js`:
- **Allow once**: a rule for exactly this action, `Bash(<command>)` or
  `Edit(<file>)` (the bare tool name for other tools, or a multi-line command).
- **Always allow "npm …" commands** (`Bash(npm *)`, from the command's first
  word) or **Always allow edits in "src"** (`Edit(<folder of the file>/**)`;
  "anywhere in the workspace" when the file is at its root). Only for `Bash` and
  the file-editing tools. For a compound command the CLI names the part that
  needs approval ("The following part requires approval: git --version") and
  both rules are built from that part.
- **Always allow the whole <Tool> tool**: the bare tool name.
- **Deny**.

All lines are also mirrored into the live status area and focus goes to the
first button. Escape does not close it. Pop-up buttons each sit on their own
line, so the screen reader's own arrow keys (browse mode, line by line) reach
every one of them; until 2026-10-17 they shared lines and only the first
button of each line could be reached that way, the others by Tab only. The
page itself does not handle the arrow keys.

**Lost popup.** The browser still closes a modal dialog by itself after
repeated Escape presses, and until 2026-10-17 an Escape could also run the
leftover Escape handler of another dialog (rename, confirm…) closed earlier by
a button, which emptied and closed the popup. Either way the run kept waiting
with no question on screen. Now each dialog replaces the previous Escape
handler instead of adding one, and if the popup closes while the request is
still pending, a **Show the permission request** button appears next to Abort,
takes the focus, and the status area says so; it reopens the same question.
**Abort** while a request is pending declines it and clears the pending state
(before, the page kept ignoring the next runs' messages and could stay
"working"); opening another session or workspace clears it too.

**Granting**: the rule is added to `--allowed-tools` (one rule per argument)
and the run resumed with `--resume` and the prompt "continue" (hidden from the
log). The "once" rule only goes with that retry; an "always" rule is kept for
the current session only, and never saved. Rule shapes were checked against
the real CLI (see `claude-p-usage.md` 4.A): an absolute Windows path is written
`//c/Users/...`.

**Mode states and the "always allowed" list**: each permission mode has a
known state for the main tools (`MODE_TOOL_STATES` in `front/runOptions.js`):

| Mode | Read | Write | Edit | Bash |
|---|---|---|---|---|
| Manual | allowed | asks | asks | asks |
| Accept edits | allowed | allowed inside the workspace only | allowed inside the workspace only | asks |
| Plan, Don't ask | allowed | denied | denied | denied |
| Auto | allowed | allowed | allowed | checked by the classifier |
| Bypass permissions | allowed | allowed | allowed | allowed |

These states are display and comparison only: they are **not** sent to the
CLI (a bare `--allowed-tools Write` would also approve writes outside the
workspace, which "Accept edits" does not). The "always allowed" list, which is
what is sent, is emptied on every change of permission mode and whenever a
session or workspace is opened. When the user has allowed "always" something
the mode does not allow, a line appears under the mode description, for example
"Always allowed despite the mode: "npm …" commands (the mode asks), edits in
"src" (the mode asks)." It is part of the select's description
(`aria-describedby`), not a live region, and hidden when there is no such
change. Under a mode that allows edits only inside the workspace ("Accept
edits"), a folder rule inside the workspace adds nothing and isn't listed; a
folder outside it, or the whole `Write`/`Edit` tool, is listed as "(the mode
allows it only inside the workspace)", since it widens the tool.

## 8. Run options

- Model (`haiku`, `sonnet`, `opus`, `fable`), effort (`low` to `max`),
  permission mode (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`,
  `bypassPermissions`), applied to every prompt including the hidden resumes.
- Defaults for new sessions come from the options page.
- The options are remembered per session, on the server (so any browser
  reopens a session the same way). They are saved as soon as a select changes,
  or, for a session without an id yet, when the CLI reports it.
- Opening a session applies, in order of priority: what was remembered for it,
  what its file says it was last run with, the defaults. A new session starts
  with the defaults. Changing workspace opens that workspace's last session, so
  it brings back that session's options.

## 9. Options page

General (language, theme), appearance and usability (messages per page,
sessions per page, title preview word count, completion sound, announce
progress, show hidden messages), defaults for new sessions (model, effort, permission mode),
advanced (listen host and port, CLI command, Claude home directory). Theme
changes preview immediately; Save writes the configuration, Reset returns to
the last saved values.

## 10. Languages, themes, sounds

French and English (`front/lang/*.json`, auto-detected unless set), three
themes (light, dark, high contrast; auto-detected from the browser unless
set), two sounds: completion and "a question is waiting".

## 11. What stays in the browser

Only the legacy workspace keys left after migration. The workspace list,
custom names, last workspace/session and the run options per session live on
the server.
