# ClaudeAccess

A minimal, self-hosted web interface for [Claude Code](https://claude.com/product/claude-code)'s
non-interactive mode (`claude -p`), built to be fully usable with a screen
reader — developed and tested against JAWS on Windows.

ClaudeAccess is not an Anthropic product, and it doesn't reimplement or
replace Claude Code. It runs the real `claude` CLI as a subprocess on your
own machine, under your own account, and just gives you a web page to talk
to it from — one designed from the start around how a screen reader actually
consumes a page, instead of a terminal UI or a chat UI adapted after the
fact.

## Why this exists

Claude Code already ships two ways to work with a screen reader, and neither
is quite enough on its own for extended use:

- **Claude Code's own screen reader mode** (`claude --ax-screen-reader`, see
  the [official docs](https://code.claude.com/docs/en/accessibility)) does a
  genuinely good job turning the terminal UI into flat, linear text a screen
  reader can follow. But it's still a terminal: composing or re-reading a
  long message means fighting a single-line input and scrollback navigation,
  and the surrounding pseudo-GUI (menus, prompts, panels), even simplified
  for screen readers, still asks you to track where keyboard focus currently
  is inside a text stream rather than inside real, navigable page structure.
- **Claude Desktop / claude.ai**, the official web/desktop chat client,
  solves the "long text" problem with a real text box, but its message list
  is an auto-scrolling, dynamically-loading region. Past 5 or 6 messages
  into a conversation, that scrolling behavior tends to fight a screen
  reader's own navigation model: focus jumps unexpectedly, or gets lost as
  content shifts underneath it.

ClaudeAccess exists to sidestep both problems: an ordinary static-feeling
HTML page, plain form controls, an `aria-live` region for streamed output
that never silently moves focus, and pagination instead of infinite
auto-scroll for message history.

## Philosophy

- **Screen reader accessibility first.** Every piece of dynamic UI (message
  streaming, permission prompts, session lists) is designed around screen
  reader behavior — focus management and `aria-live` semantics — as part of
  the feature itself, not a pass applied afterwards.
- **Deliberately minimal.** Plain HTML/CSS/JS, no frontend framework, no
  build step. The interface only does what a screen reader user actually
  needs to run Claude Code: pick a working directory, send a prompt, read
  the response, manage sessions, answer permission prompts. Nothing more.

## How it works

ClaudeAccess is a small Node.js app with two halves:

- A backend (Express + [`ws`](https://github.com/websockets/ws)) that spawns
  `claude -p ... --output-format stream-json` as a child process per
  request, streams its output to the browser over a WebSocket, and forwards
  permission prompts and their answers back and forth.
- A static frontend (plain HTML/CSS/ES modules, no framework) that renders
  that stream into an accessible page, and reads/writes Claude Code's own
  on-disk session history (`~/.claude/projects/...`) — ClaudeAccess keeps no
  history of its own, it's just another window onto the same sessions
  `claude` itself already manages.

Because it drives the real CLI, everything Claude Code already provides —
authentication, session resumption, models, permission modes, tool use — is
available; ClaudeAccess only adds the accessible page in front of it.

## Requirements

- [Claude Code](https://claude.com/product/claude-code) installed and
  already authenticated (`claude` working from a terminal) — ClaudeAccess
  does not handle login itself, it just invokes whatever `claude` command is
  configured (see the options page).
- Node.js.
- Currently developed and tested on Windows; some features (e.g. the native
  folder-picker dialog) currently shell out to PowerShell and are
  Windows-only for now.

## Getting started

```bash
npm install
npm run start
```

Then open the app in your browser (default: `http://localhost:1080`) and
set your working directory from the options page. See
[CLAUDE.md](CLAUDE.md) for the available `npm run` scripts, including a mock
CLI mode for frontend work that doesn't consume real Claude usage.

## Risks — please read before using this

ClaudeAccess runs the `claude` CLI's own documented, official
[non-interactive/headless mode](https://code.claude.com/docs/en/headless)
(`-p`) as a subprocess, with your own credentials — it never touches, stores,
or forwards your OAuth tokens or API keys, and it never talks to Anthropic's
servers directly. In that sense it's no different from typing
`claude -p "..."` yourself in a terminal, just from a web page instead.

That said, Anthropic's [Legal and compliance
docs](https://code.claude.com/docs/en/legal-and-compliance) are explicit that
OAuth authentication on a Free/Pro/Max/Team/Enterprise plan is "intended
exclusively... to support **ordinary use** of Claude Code and other native
Anthropic applications", and that Anthropic "reserves the right to take
measures to enforce these restrictions... without prior notice." Whether
driving `claude -p` from a custom accessible frontend, repeatedly and as
someone's primary way of using Claude Code, still counts as "ordinary
individual use" of a subscription plan is not explicitly settled one way or
the other in that policy. It is *not* the kind of use the policy is aimed at
(no token extraction, no serving other users, no third-party API access) —
but it's also not a scenario the docs address directly, so treat this as a
genuine, currently-unresolved gray area rather than a confirmed green light.

If you'd rather not carry that uncertainty, the safer path is to use an
[API key](https://platform.claude.com/) instead of an OAuth/subscription
login for the `claude` command ClaudeAccess invokes — see [Authentication
and credential use](https://code.claude.com/docs/en/legal-and-compliance) in
the same docs.

## Status

Early, personal project, published in the hope it's useful to other screen
reader users of Claude Code. Issues and pull requests welcome.
