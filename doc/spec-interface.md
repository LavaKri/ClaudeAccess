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
   `aria-live="polite"`), session options menu, token usage, message log,
   message pagination, the question dialog, the prompt form, and the
   **Progress** region at the very bottom of the page.

Two-column grid on wide screens, single column on narrow ones.

## 2. Workspaces

The list is the user's own, kept on the server (`workspaces.json`), in the
order entries were added, paginated with Newer / Older buttons.

- Choosing a workspace makes it current and opens its most recent session;
  with no sessions the conversation stays empty.
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

Listed newest first for the current workspace, paginated.

- **New session**, **Refresh sessions**, choose one to open it (the last page
  of its messages is shown).
- Per-session menu: rename, duplicate, delete (confirm), move to another
  workspace.
- Session options menu (current session): rename, duplicate, copy the whole
  session as Markdown, export it as a Markdown file, move.
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
- Pagination: first / previous / page number field / next / last, over
  `messagesPerPage` groups. After a run or when opening a session the view
  follows the last page; a user reading an earlier page is left alone.
- Per-group menu: copy.
- Noise hidden in rebuilt history: CLI-written `<synthetic>` replies, "No
  response requested." replies and bare "continue" prompts. The live log
  likewise adds nothing for a `<synthetic>` turn (no message, no sound).

## 5. Prompt and run

- The prompt field sends with **Ctrl+Enter** or the Send button. While a run is
  in progress the field is read-only, Send is disabled and Abort is enabled.
- After sending, focus moves from the Send button to the **progress line**
  (rather than the "Prompt" region), and its text is written without a live
  announcement because focus already reads it.
- At the end of a response: status message, optional completion sound, the
  reply is appended, token usage is added up, the title is fetched shortly
  after for a new session, and a suggested next prompt (if any) fills the
  field.

## 6. Progress region

A region named "Progress" holding one line of text.

- Idle: "Waiting for a prompt". Working: "Claude is working…".
- Steps taken from the stream: starting, thinking, writing the reply, and each
  tool use as `<Tool> <text>` (tool names are never translated; the text is the
  main parameter, cut at 80 characters), then `<Tool> done` or
  `<Tool>: error`. While a permission question is open: "Waiting for
  permission".
- Option "Announce progress steps with the screen reader" (on by default):
  turns `aria-live="polite"` on the region on or off; the line is always
  readable by navigating to it.

## 7. Tool permissions

The CLI cannot pause for approval in `-p` mode, so the interface handles it.

**What counts as a permission request**
- A tool result whose error says "you haven't granted it yet" (the wording
  confirmed for `Write`): the CLI is cut at once and the popup shown.
- Any other tool error ("String to replace not found", "File has been
  modified since read"…) is an ordinary failure: nothing is cut, no popup, the
  model corrects itself; the progress line says "<Tool>: error".
- At the end of a run, entries in the result's `permission_denials` whose
  wording wasn't recognised get the popup then ("Denial reported at the end
  of the run"); this also covers `dontAsk`.
- A denial for a tool that is already allowed (always, or once for this run)
  gets no popup, since allowing again can't help (protected path, deny rule):
  an error is added to the log instead.

**The popup**: line 1 "Claude wants to use the `<Tool>` tool"; line 2 the
tool's main parameter (a file shown relative to the workspace, or its full path
when outside it; a command; a search pattern; a URL…); a warning line when the
file is outside the workspace (the path starts with a drive letter or
separator); a last line with the raw CLI error text. Buttons: **Allow once**,
**Always allow**, **Deny**. All lines are also mirrored into the live status
area and focus goes to the first button. Escape does not close it.

**Granting**: the tool is added to `--allowed-tools` and the run resumed with
`--resume` and the prompt "continue" (hidden from the log). "Always allow"
keeps the tool for the current session only: it is allowed for every tool
use, whatever the command or path, and never saved.

**Mode states and the "always allowed" list**: each permission mode has a
known state for the main tools (`MODE_TOOL_STATES` in `front/runOptions.js`):

| Mode | Read | Write | Edit | Bash |
|---|---|---|---|---|
| Manual | allowed | asks | asks | asks |
| Accept edits | allowed | allowed | allowed | asks |
| Plan, Don't ask | allowed | denied | denied | denied |
| Auto | allowed | allowed | allowed | checked by the classifier |
| Bypass permissions | allowed | allowed | allowed | allowed |

These states are display and comparison only: they are **not** sent to the
CLI (a bare `--allowed-tools Write` would also approve writes outside the
workspace, which "Accept edits" does not). The "always allowed" list, which is
what is sent, is emptied on every change of permission mode and whenever a
session or workspace is opened. When the user has allowed "always" a tool the
mode does not allow, a line appears under the mode description, for example
"Always allowed despite the mode: Write (the mode asks), Bash (the mode
asks)." It is part of the select's description (`aria-describedby`), not a
live region, and hidden when there is no such change. Known gap: allowing a
tool the mode already allows (such as `Write` in "Accept edits") shows
nothing, yet widens it to every path.

## 8. Run options

- Model (`haiku`, `sonnet`, `opus`, `fable`), effort (`low` to `max`),
  permission mode (`default`, `acceptEdits`, `plan`, `auto`, `dontAsk`,
  `bypassPermissions`), applied to every prompt including the hidden resumes.
- Defaults for new sessions come from the options page.
- This browser remembers the options per session and the last ones used, as a
  fallback only.

## 9. Options page

General (language, theme), appearance and usability (messages per page,
sessions per page, title preview word count, completion sound, announce
progress), defaults for new sessions (model, effort, permission mode),
advanced (listen host and port, CLI command, Claude home directory). Theme
changes preview immediately; Save writes the configuration, Reset returns to
the last saved values.

## 10. Languages, themes, sounds

French and English (`front/lang/*.json`, auto-detected unless set), three
themes (light, dark, high contrast; auto-detected from the browser unless
set), two sounds: completion and "a question is waiting".

## 11. What stays in the browser

Only the run options remembered per session and last used (fallback), and the
legacy workspace keys left after migration. The workspace list, custom names
and last workspace/session live on the server.
