# Open questions

Working notes: decisions not made yet, things left unverified, and ideas
parked for later. Each entry says where things stand and what the next step
is. When an entry is settled, move its outcome to `plan.md` (or the code, or
`claude-p-usage.md` for the way `claude -p` is driven) and delete it here.

Last updated: 2026-10-18.

## 1. Permission mode descriptions

The one-line descriptions on the main page come from the Claude Code docs,
not from tests. Docs say `acceptEdits` also auto-approves `mkdir`, `touch`,
`rm`, `rmdir`, `mv`, `cp`, `sed` inside the working directory, which the
current French / English text only covers as "common file commands". `auto`
availability depends on model and account, and the docs say a session with no
explicit mode may start in auto: ClaudeAccess always passes
`--permission-mode`, so this does not apply, but check it stays true.

## 2. "Send in a new branch" button

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

## 3. Task list

In the official interface you can view Claude's task list. Check how it comes
through the `claude -p` stream, then choose where to show it (a region read
on demand, like "Claude usage", or a popup).