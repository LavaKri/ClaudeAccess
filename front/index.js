import { create } from './DOMHelpers.js';
import { initI18n, t, getLanguage } from './i18n.js';
import { initTheme } from './theme.js';
import { fetchConfig } from './ConfigClient.js';
import { MODELS, EFFORTS, PERMISSION_MODES, populateSelect } from './runOptions.js';
import { connect, send } from './WsClient.js';
import {
	fetchProjects, fetchSessions, fetchSession,
	renameSession as renameSessionRequest,
	deleteSession as deleteSessionRequest,
	duplicateSession as duplicateSessionRequest,
	moveSession as moveSessionRequest,
} from './HistoryClient.js';
import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

// html is left at its default (false): raw HTML in a message is escaped
// rather than inserted, since message text ultimately comes from model
// output and must not be trusted as markup.
const md = new MarkdownIt();

const LAST_WORKSPACE_KEY = 'claudeAccessible.lastWorkspace';
const LAST_SESSION_KEY = 'claudeAccessible.lastSessionId';
const WORKSPACE_NAMES_KEY = 'claudeAccessible.workspaceNames';
const EXTRA_WORKSPACES_KEY = 'claudeAccessible.extraWorkspaces';
const HIDDEN_WORKSPACES_KEY = 'claudeAccessible.hiddenWorkspaces';
const RUN_OPTIONS_PREFIX = 'claudeAccessible.runOptions.';
const LAST_RUN_OPTIONS_KEY = 'claudeAccessible.lastRunOptions';

// Set from config.completionSound in onWindowLoad — governs both sounds
// below, no separate toggle per sound.
let completionSoundEnabled = true;
// One Audio instance per clip, created lazily (not at module load) and
// reused across turns, rather than a fresh `new Audio()` each time, so a
// quick back-to-back trigger restarts the same clip instead of piling up
// overlapping playbacks.
let audioCache = new Map();

function playSound (fileName) {
	if (!completionSoundEnabled) return;
	let audio = audioCache.get(fileName);
	if (!audio) {
		audio = new Audio(fileName);
		audioCache.set(fileName, audio);
	}
	audio.currentTime = 0;
	// Autoplay can be blocked by the browser (e.g. no user gesture on this
	// page yet) — non-fatal, the aria-live status text already announces
	// the same event either way.
	audio.play().catch(() => {});
}

// Resolved lazily via t() rather than at module load, since translations
// aren't loaded yet at this point — see initI18n() in onWindowLoad.
function defaultTitle () {
	return t('session.defaultTitle');
}
let currentSessionTitle = '';

let currentCwd = '';
let currentSessionId = null;
// Tools the user chose "Always allow" for in the current session: later
// requests for them are answered automatically, client-side (nothing is
// written to Claude Code's own permission settings — see plan.md).
let allowedTools = [];

// Last `status` message from the server, describing the single claude
// process shared by the whole server (see server/cliProcess.js): which
// workspace/session it runs, and whether it's stopped, idle, working, or
// waiting for an answer. null until the first one arrives.
let processState = null;
// Set when sending the first prompt of a brand new session: the session id
// is only known once the server reports it in a status message. Holds the
// process's session id at send time, so a stale status still carrying the
// previous session isn't mistaken for the new one.
let pendingNewSession = null; // { previousSessionId }
// The last prompt sent, kept to re-send it if the server asks to confirm a
// restart first (see onConfirmRestart).
let lastPromptPayload = null;
// Messages sent while Claude was already working: each acknowledgment
// (replayed user message) announces that Claude has now read one of them.
let messagesSentWhileBusy = 0;
// Set by the Abort button, so the `result` that follows reads as an
// interruption rather than a generic error.
let abortRequested = false;
// After a lost connection, whatever streamed in meanwhile was missed: the
// displayed session is reloaded from disk on the next status.
let resyncOnNextStatus = false;
// Known working directories, loaded once so workspace buttons can show a
// short label while still knowing the full path to switch to.
let workspaces = [];
// True right after starting a brand new (non-resumed) prompt: the real title
// isn't known yet, since Claude Code writes it to disk asynchronously after
// the turn ends — see plan.md. Used to trigger a delayed fetch once done.
let awaitingFreshTitle = false;

function wait (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Reads the model/effort/permission-mode selects next to the prompt form, so
// every prompt sent uses the values currently chosen (changing them while
// Claude runs is also applied live — see onRunOptionChange).
function getRunOptions () {
	return {
		model: document.getElementById('modelSelect').value,
		effort: document.getElementById('effortSelect').value,
		permissionMode: document.getElementById('permissionModeSelect').value,
	};
}

function applyRunOptions (options) {
	if (!options) return;
	setSelectValue(document.getElementById('modelSelect'), options.model);
	setSelectValue(document.getElementById('effortSelect'), options.effort);
	setSelectValue(document.getElementById('permissionModeSelect'), options.permissionMode);
}

// Ignores values the select has no option for (e.g. a model the process
// reports that this UI doesn't list), which would otherwise leave it blank.
function setSelectValue (select, value) {
	if (value && [...select.options].some(option => option.value === value)) select.value = value;
}

// Remembers model/effort/permission-mode per session (so reopening a session
// restores what was last used there), and also as a standalone "last used"
// fallback for brand new sessions — `claude` itself has no notion of a
// per-session default to inherit instead.
function saveRunOptionsForSession (sessionId, options) {
	if (sessionId) localStorage.setItem(RUN_OPTIONS_PREFIX + sessionId, JSON.stringify(options));
	localStorage.setItem(LAST_RUN_OPTIONS_KEY, JSON.stringify(options));
}

function loadRunOptionsForSession (sessionId) {
	try {
		let raw = sessionId ? localStorage.getItem(RUN_OPTIONS_PREFIX + sessionId) : localStorage.getItem(LAST_RUN_OPTIONS_KEY);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}

// Overridden from config (titlePreviewWordCount) once it's fetched in
// onWindowLoad.
let PREVIEW_WORD_COUNT = 20;

// First sentence of the text if it's short enough, otherwise the first
// PREVIEW_WORD_COUNT words — used so screen reader users can jump message to
// message via headings without having the whole text read out each time.
function previewText (text) {
	let firstSentence = text.match(/^.*?[.!?](\s|$)/);
	if (firstSentence && firstSentence[0].split(/\s+/).length <= PREVIEW_WORD_COUNT) {
		return firstSentence[0].trim();
	}
	let words = text.trim().split(/\s+/);
	return words.length > PREVIEW_WORD_COUNT
		? words.slice(0, PREVIEW_WORD_COUNT).join(' ') + '…'
		: words.join(' ');
}

// If `text` starts with a markdown ATX heading ("# ", "## ", ...), returns
// its clean title (no leading "#"s) and the remaining text with that heading
// line stripped out — so the heading can be used as-is for the group's own
// H2 instead of being both shown raw in the preview *and* re-rendered as a
// duplicate H2 by markdown-it right below it. Returns null otherwise.
function splitLeadingHeading (text) {
	let match = text.match(/^\s*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\r?\n|$)/);
	if (!match) return null;
	return { title: match[1].trim(), rest: text.slice(match[0].length) };
}

// All messages of the current conversation, paginated for display rather than
// shown as one continuously growing log — a continuously auto-scrolling
// region is exactly the kind of thing that's hard to use with JAWS.
// Consecutive messages of the same kind (several "Claude a répondu" in a row,
// several tool uses in a row...) are grouped under a single heading — each
// group is one pagination unit, holding one paragraph per message.
// Overridden from config (messagesPerPage) once it's fetched in onWindowLoad.
let PAGE_SIZE = 20;
let messages = [];
let currentPage = 1;

// Tool-use groups don't count as their own pagination unit (see
// renderMessages) — only "you"/"claude"/"error" groups do.
function countablePageGroups () {
	return messages.filter(group => group.prefix !== 'tool').length;
}

function pageCount () {
	return Math.max(1, Math.ceil(countablePageGroups() / PAGE_SIZE));
}

// Page numbers to show as buttons, null standing for an ellipsis: always the
// first and last pages, plus the pages right before and after the current
// one. A gap of a single page shows that page's number instead of an
// ellipsis, since "1 2 3" is no longer than "1 … 3".
function paginationItems (current, total) {
	let pages = [...new Set([1, current - 1, current, current + 1, total])]
		.filter(page => page >= 1 && page <= total)
		.sort((a, b) => a - b);
	let items = [];
	let previous = 0;
	for (let page of pages) {
		if (page - previous === 2) items.push(previous + 1);
		else if (page - previous > 2) items.push(null);
		items.push(page);
		previous = page;
	}
	return items;
}

// The page-number buttons as last rendered ("current/total"): they're only
// rebuilt when that changes, so a message streaming in doesn't destroy a
// button the user is sitting on.
let renderedPaginationState = '';

// No edit field here (only buttons, plus "Go to page" opening a dialog), so
// the screen reader's "next edit field" key always lands on the prompt; the
// whole block is hidden while there's only one page.
function updatePaginationControls () {
	let pages = pageCount();
	let focused = document.activeElement;
	document.getElementById('paginationArea').hidden = pages <= 1;

	let state = `${currentPage}/${pages}`;
	if (state !== renderedPaginationState) {
		renderedPaginationState = state;
		let focusedPage = focused?.closest?.('#pageButtons') ? Number(focused.dataset.page) : null;
		let container = document.getElementById('pageButtons');
		container.textContent = '';
		for (let page of paginationItems(currentPage, pages)) {
			if (page === null) {
				container.appendChild(create('span', '…'));
				continue;
			}
			let button = create('button', String(page));
			button.type = 'button';
			button.dataset.page = page;
			button.setAttribute('aria-label', t('aria.pageButton', { page }));
			if (page === currentPage) button.setAttribute('aria-current', 'page');
			button.addEventListener('click', () => goToPage(page));
			container.appendChild(button);
		}
		// Rebuilding destroyed the focused button: put focus back on the same
		// page number if it's still shown (a re-render while the user sits on
		// it), else on the current page (the button clicked became current).
		if (focusedPage !== null) {
			let target = container.querySelector(`button[data-page="${focusedPage}"]`)
				|| container.querySelector('button[aria-current="page"]');
			target?.focus();
		}
	}

	let prevButton = document.getElementById('prevPageButton');
	let nextButton = document.getElementById('nextPageButton');
	prevButton.disabled = currentPage <= 1;
	nextButton.disabled = currentPage >= pages;
	// A disabled button can't keep focus: on reaching the first/last page,
	// move it to the current page's button instead of losing it.
	if ((focused === prevButton || focused === nextButton) && focused.disabled) {
		document.querySelector('#pageButtons button[aria-current="page"]')?.focus();
	}
}

async function onGoToPageClick () {
	let total = pageCount();
	let value = await showInputDialog(t('dialog.goToPageTitle'), t('dialog.goToPageLabel', { total }), String(currentPage));
	if (value === null) return;
	let page = Number(value.trim());
	if (!Number.isInteger(page) || page < 1 || page > total) {
		setStatus(t('status.invalidPage', { total }));
		return;
	}
	goToPage(page);
}

async function copyTextToClipboard (text) {
	try {
		await navigator.clipboard.writeText(text);
		setStatus(t('status.copied'));
	} catch {
		setStatus(t('status.copyFailed'));
	}
}

// Per-message options (currently just "Copier", copying the original markdown
// text, not any rendered HTML) — only offered for actual conversation turns
// ("Vous dites" / "Claude a répondu"), not for tool-use or error entries. One
// menu per rendered H2 group, not per individual message within it — "text"
// here is already the whole group's messages joined together.
function buildMessageOptions (text) {
	let details = document.createElement('details');
	details.appendChild(create('summary', t('details.messageOptions')));
	let copyButton = create('button', t('button.copy'));
	copyButton.type = 'button';
	copyButton.addEventListener('click', () => copyTextToClipboard(text));
	details.appendChild(copyButton);
	return details;
}

// Renders the markdown of a conversation-turn message (user prompt or
// Claude's answer) into a container element. Rendered once, from the
// complete final text — never incrementally while a result is streaming in —
// so JAWS never sees the content it's reading change out from under it.
function renderMarkdownMessage (text) {
	let container = document.createElement('div');
	container.className = 'message-text';
	container.innerHTML = md.render(text);
	return container;
}

// A tool-use group's texts are structured entries ({ kind, label }) rather
// than plain strings — see cacheToolUse(). Builds the collapsed-by-default
// <details>/<summary> replacing the old "Outil" H2: the summary gives counts,
// the body lists files read / commands run / other tools invoked separately.
function buildToolDetails (entries) {
	let files = entries.filter(e => e.kind === 'file').map(e => e.label);
	let commands = entries.filter(e => e.kind === 'command').map(e => e.label);
	let others = entries.filter(e => e.kind === 'other').map(e => e.label);

	let summaryParts = [];
	if (files.length) summaryParts.push(t('tool.summary.filesCount', { count: files.length }));
	if (commands.length) summaryParts.push(t('tool.summary.commandsCount', { count: commands.length }));
	if (others.length) summaryParts.push(t('tool.summary.othersCount', { count: others.length }));

	let details = document.createElement('details');
	details.appendChild(create('summary', summaryParts.join(', ') || t('details.toolsUsed')));

	function appendList (heading, items) {
		if (!items.length) return;
		details.appendChild(create('h3', heading));
		let ul = document.createElement('ul');
		for (let item of items) ul.appendChild(create('li', item));
		details.appendChild(ul);
	}
	appendList(t('tool.list.filesHeading'), files);
	appendList(t('tool.list.commandsHeading'), commands);
	appendList(t('tool.list.othersHeading'), others);

	return details;
}

function toolEntryText (entry) {
	if (entry.kind === 'file') return t('tool.export.file', { path: entry.label });
	if (entry.kind === 'command') return t('tool.export.command', { command: entry.label });
	return t('tool.export.other', { tool: entry.label });
}

// Re-renders only the message groups of the current page. Each conversation/
// error group is its own H2 (heading text: "<prefix>: <preview or leading
// heading of the first message>"), so JAWS users can navigate group-to-group
// with heading-navigation keys, followed by one paragraph per message in that
// group. Tool-use groups render as a collapsed details/summary instead of an
// H2, wherever they fall relative to the surrounding conversation groups, and
// don't consume a pagination slot of their own (see countablePageGroups()).
function renderMessages () {
	currentPage = Math.min(Math.max(currentPage, 1), pageCount());
	let start = (currentPage - 1) * PAGE_SIZE;
	let end = start + PAGE_SIZE;

	let messageArea = document.getElementById('messageArea');
	messageArea.textContent = '';
	let countableIndex = -1;
	for (let group of messages) {
		if (group.prefix === 'tool') {
			if (countableIndex >= start && countableIndex < end) messageArea.appendChild(buildToolDetails(group.texts));
			else if (countableIndex === -1 && start === 0) messageArea.appendChild(buildToolDetails(group.texts));
			continue;
		}

		countableIndex++;
		if (countableIndex < start || countableIndex >= end) continue;

		let isConversationTurn = group.prefix === 'you' || group.prefix === 'claude';
		let heading = group.prefix === 'claude' ? splitLeadingHeading(group.texts[0]) : null;
		messageArea.appendChild(create('h2', `${t('message.prefix.' + group.prefix)}: ${heading ? heading.title : previewText(group.texts[0])}`));
		for (let [index, text] of group.texts.entries()) {
			let renderedText = (index === 0 && heading) ? heading.rest : text;
			messageArea.appendChild(isConversationTurn ? renderMarkdownMessage(renderedText) : create('p', renderedText));
		}
		// One options menu per H2 group, not one per individual message within
		// it — "Copier" then copies the whole group's messages joined together.
		if (isConversationTurn) messageArea.appendChild(buildMessageOptions(group.texts.join('\n\n')));
	}
	updatePaginationControls();
}

function goToPage (page) {
	if (Number.isInteger(page)) currentPage = page;
	renderMessages();
	setStatus(t('status.page', { page: currentPage, total: pageCount() }));
}

// Adds a message to the log, merging it into the previous group when it's the
// same kind (prefix) as the one right before it, and silently dropping it
// when it's an exact repeat of the last message in that group — which is what
// happens when a tool retried after a permission grant reports the exact same
// tool_use again (text is a plain string for "you"/"claude"/"error" groups,
// or a { kind, label } entry for "tool" groups — see cacheToolUse()). If the
// user was already viewing the last page, follows along to the new last page;
// otherwise leaves their current page alone.
function appendMessage (prefix, text) {
	let lastGroup = messages[messages.length - 1];
	let mergingIntoLast = Boolean(lastGroup) && lastGroup.prefix === prefix;
	let lastText = mergingIntoLast ? lastGroup.texts[lastGroup.texts.length - 1] : undefined;
	if (mergingIntoLast && JSON.stringify(lastText) === JSON.stringify(text)) return;

	let wasOnLastPage = currentPage >= pageCount();
	if (mergingIntoLast) lastGroup.texts.push(text);
	else messages.push({ prefix, texts: [text] });

	if (wasOnLastPage) {
		currentPage = pageCount();
		renderMessages();
	} else {
		updatePaginationControls();
	}
}

// Short, separate aria-live region: announces state changes ("Working...",
// "Response finished") without re-reading the whole (long, eventually
// markdown-formatted) message log on every update.
function setStatus (text) {
	document.getElementById('statusArea').textContent = text;
}

function setSessionTitle (title) {
	currentSessionTitle = title;
	document.title = t('page.titleWithSession', { title });
	document.getElementById('sessionTitle').textContent = title;
}

// Token usage, input/output kept separate (useful to know which side is
// driving cost if usage-based billing ever becomes relevant), plus the two
// cache-related counters the API actually reports — there's no such thing as
// "cache output" tokens, only cache writes (cache_creation_input_tokens, i.e.
// content newly written to the cache) and cache reads (cache_read_input_tokens,
// i.e. content reused from it), both on the input side. For a resumed
// session, the starting total is recomputed server-side from the session's
// own file (session.tokenUsage — see history.js) rather than starting back
// at 0, since the CLI's live stream only ever gives a per-turn figure, not a
// running total.
let sessionTokenTotals = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

function renderTokenUsage (lastTurn) {
	let area = document.getElementById('tokenUsageArea');
	let totals = sessionTokenTotals;
	let hasAnyTotal = totals.input || totals.output || totals.cacheCreation || totals.cacheRead;
	if (!lastTurn && !hasAnyTotal) {
		area.textContent = '';
		return;
	}
	let lastTurnText = lastTurn ? t('tokenUsage.turn', lastTurn) : '';
	area.textContent = lastTurnText + t('tokenUsage.total', totals);
}

function resetTokenUsage (seed) {
	sessionTokenTotals = {
		input: seed?.input || 0,
		output: seed?.output || 0,
		cacheCreation: seed?.cacheCreation || 0,
		cacheRead: seed?.cacheRead || 0,
	};
	renderTokenUsage(null);
}

function recordTokenUsage (usage) {
	if (!usage) return;
	let turn = {
		input: usage.input_tokens ?? 0,
		output: usage.output_tokens ?? 0,
		cacheCreation: usage.cache_creation_input_tokens ?? 0,
		cacheRead: usage.cache_read_input_tokens ?? 0,
	};
	sessionTokenTotals.input += turn.input;
	sessionTokenTotals.output += turn.output;
	sessionTokenTotals.cacheCreation += turn.cacheCreation;
	sessionTokenTotals.cacheRead += turn.cacheRead;
	renderTokenUsage(turn);
}

// All message texts (every group, every kind — a full raw dump of the log,
// not just the current page) joined with a "---" separator, for the
// copy/export-whole-session options below.
function buildSessionMarkdown () {
	return messages
		.flatMap(group => group.prefix === 'tool' ? group.texts.map(toolEntryText) : group.texts)
		.join('\n\n---\n\n');
}

function exportSessionMarkdown () {
	let blob = new Blob([buildSessionMarkdown()], { type: 'text/markdown' });
	let url = URL.createObjectURL(blob);
	let link = document.createElement('a');
	link.href = url;
	link.download = `${(currentSessionTitle || defaultTitle()).replace(/[\\/:*?"<>|]+/g, '_')}.md`;
	link.click();
	URL.revokeObjectURL(url);
}

// Options for the session as a whole, shown before the message log. Renommer/
// Dupliquer reuse the same actions as the session list's own options;
// Copier/Exporter work on the in-memory log directly, so they're available
// even for a brand new, not-yet-saved session.
function renderSessionOptions () {
	let container = document.getElementById('sessionOptionsArea');
	container.textContent = '';

	let details = document.createElement('details');
	details.appendChild(create('summary', t('details.sessionOptions')));

	let renameButton = create('button', t('button.rename'));
	renameButton.type = 'button';
	renameButton.disabled = !currentSessionId;
	renameButton.addEventListener('click', () => renameSession(currentSessionId, currentSessionTitle));

	let duplicateButton = create('button', t('button.duplicate'));
	duplicateButton.type = 'button';
	duplicateButton.disabled = !currentSessionId;
	duplicateButton.addEventListener('click', () => duplicateSessionAction(currentSessionId));

	let copyButton = create('button', t('button.copyAllSession'));
	copyButton.type = 'button';
	copyButton.addEventListener('click', () => copyTextToClipboard(buildSessionMarkdown()));

	let exportButton = create('button', t('button.exportAllSession'));
	exportButton.type = 'button';
	exportButton.addEventListener('click', exportSessionMarkdown);

	let moveButton = create('button', t('button.move'));
	moveButton.type = 'button';
	moveButton.disabled = !currentSessionId;
	moveButton.addEventListener('click', () => moveSessionAction(currentSessionId));

	details.appendChild(renameButton);
	details.appendChild(duplicateButton);
	details.appendChild(copyButton);
	details.appendChild(exportButton);
	details.appendChild(moveButton);
	container.appendChild(details);
}

// Only fills an empty prompt field: the user may now be typing a follow-up
// while Claude works, which a suggestion mustn't overwrite.
function suggestPrompt (suggestion) {
	let field = document.getElementById('prompt');
	if (!field.value.trim()) field.value = suggestion;
}

function samePath (a, b) {
	return Boolean(a) && Boolean(b) && normalizeWorkspacePath(a) === normalizeWorkspacePath(b);
}

function isProcessBusy () {
	return processState?.status === 'working' || processState?.status === 'waiting';
}

// True when the claude process runs the session shown on this page — the
// only case where what it streams belongs in this message log. With a single
// process for the whole server, it may well be running another session
// (picked in another tab, or before switching workspace here).
function isFollowingProcess () {
	return Boolean(processState?.sessionId) && processState.sessionId === currentSessionId && samePath(processState.cwd, currentCwd);
}

// Persistent description of what Claude is doing, in its own aria-live
// region right above the prompt field (see index.html): read out on every
// change, and still there to re-read on demand. Unlike #statusArea, which
// carries transient feedback ("Copied", "Page 2 of 5"...) and would lose the
// state as soon as anything else is announced.
function processStatusText () {
	if (!processState) return t('process.unknown');
	if (processState.status === 'stopped') return t(processState.reason ? `process.stopped.${processState.reason}` : 'process.stopped');
	let text = t(`process.${processState.status}`);
	if (!isFollowingProcess()) text = t('process.elsewhere', { status: text, workspace: workspaceLabel(processState.cwd) });
	return text;
}

// Abort is available whenever Claude is busy, whichever session it's busy
// with (the status text says where). Send always stays available: a message
// sent while Claude works is read by it at its next step.
function renderProcessStatus () {
	document.getElementById('abortButton').disabled = !isProcessBusy();
	// A restart's "stopped" lasts a few milliseconds before "working": not
	// worth announcing.
	if (processState?.status === 'stopped' && processState.reason === 'restart') return;
	document.getElementById('processStatus').textContent = processStatusText();
}

function onStatus (state) {
	processState = state;

	// First status naming the session our new-session prompt just created.
	if (pendingNewSession && !currentSessionId && state.sessionId
		&& state.sessionId !== pendingNewSession.previousSessionId && samePath(state.cwd, currentCwd)) {
		pendingNewSession = null;
		currentSessionId = state.sessionId;
		localStorage.setItem(LAST_SESSION_KEY, currentSessionId);
		saveRunOptionsForSession(currentSessionId, getRunOptions());
		renderSessionOptions();
		updateSessionAriaCurrent();
	}

	// Mirrors the process's actual settings in the selects: the CLI can
	// change the permission mode by itself (e.g. once a plan is approved).
	if (isFollowingProcess()) {
		applyRunOptions({ model: state.model, effort: state.effort, permissionMode: state.permissionMode });
		saveRunOptionsForSession(currentSessionId, getRunOptions());
	}

	// Nothing is pending server-side anymore: drop whatever this page still
	// shows (answered from another tab, or the process stopped).
	if (state.status !== 'waiting') clearPermissionQueue();

	if (resyncOnNextStatus) {
		resyncOnNextStatus = false;
		if (isFollowingProcess()) resumeSession(currentSessionId);
	}

	renderProcessStatus();
}

// The claude process outlives the connection (see server/cliProcess.js): a
// running turn goes on without us. Its state is unknown until WsClient's
// automatic reconnection brings a fresh status, and anything streamed in the
// meantime is reloaded from disk then (see onStatus).
function onConnectionLost () {
	processState = null;
	resyncOnNextStatus = true;
	renderProcessStatus();
}

// The payload couldn't be sent at all (server unreachable even after a
// reconnection attempt).
function onSendFailed () {
	setStatus(t('status.connectionFailed'));
}

function hideQuestion () {
	let dialog = document.getElementById('questionArea');
	dialog.oncancel = null;
	dialog.textContent = '';
	if (dialog.open) dialog.close();
}

// Permission requests and questions (`can_use_tool` control requests) still
// waiting for an answer, in arrival order, keyed by request id. Claude is
// blocked until each is answered, so they're shown one at a time in the
// shared dialog, as soon as it's free — another dialog (rename...) may be
// open when one arrives, in which case it waits for that one to close.
let permissionQueue = new Map();
let shownPermissionId = null;

function enqueuePermissionRequest ({ request_id: requestId, request }) {
	// Already known: re-sent by the server on reconnection.
	if (permissionQueue.has(requestId)) return;
	if (request.tool_name !== 'AskUserQuestion' && isFollowingProcess() && allowedTools.includes(request.tool_name)) {
		answerPermission(requestId, { behavior: 'allow', updatedInput: request.input });
		return;
	}
	permissionQueue.set(requestId, request);
	playSound('ask.mp3');
	showNextPermissionRequest();
}

function showNextPermissionRequest () {
	let dialog = document.getElementById('questionArea');
	if (dialog.open || !permissionQueue.size) return;
	let [requestId, request] = permissionQueue.entries().next().value;
	shownPermissionId = requestId;
	if (request.tool_name === 'AskUserQuestion') renderUserQuestions(requestId, request);
	else renderPermissionRequest(requestId, request);
}

function answerPermission (requestId, response) {
	permissionQueue.delete(requestId);
	if (shownPermissionId === requestId) hideQuestion();
	send({ type: 'permission_response', requestId, response }).catch(onSendFailed);
}

// The CLI withdrew the request (an interrupt while it was pending).
function cancelPermissionRequest (requestId) {
	if (!permissionQueue.delete(requestId)) return;
	if (shownPermissionId === requestId) {
		hideQuestion();
		setStatus(t('status.requestCancelled'));
	}
}

function clearPermissionQueue () {
	permissionQueue.clear();
	if (shownPermissionId) hideQuestion();
}

// Common frame of the permission/question dialogs: a heading naming the
// dialog, plus a note when the request comes from a session other than the
// one shown here. Escape is blocked: Claude waits for an actual answer.
function startPermissionDialog (title) {
	let dialog = document.getElementById('questionArea');
	dialog.textContent = '';
	dialog.oncancel = event => event.preventDefault();
	let heading = create('h2', title);
	heading.id = 'permissionDialogTitle';
	dialog.setAttribute('aria-labelledby', heading.id);
	dialog.appendChild(heading);
	if (processState && !isFollowingProcess()) {
		dialog.appendChild(create('p', t('permission.otherSession', { workspace: workspaceLabel(processState.cwd) })));
	}
	return dialog;
}

function appendDialogButton (container, label, onClick) {
	let button = create('button', label);
	button.type = 'button';
	button.addEventListener('click', onClick);
	container.appendChild(button);
	return button;
}

// Messages for Claude itself (sent back as the denied tool's result), hence
// in English like the rest of what the CLI tells the model, whatever the UI
// language.
const DENIED_MESSAGE = 'The user denied permission for this action.';
const PLAN_REJECTED_MESSAGE = 'The user rejected this plan. Stay in plan mode and wait for their feedback.';
const QUESTIONS_DECLINED_MESSAGE = 'The user declined to answer these questions.';

// A closed question (allow once / always allow / deny / deny with a message
// for Claude) — or, for a plan submitted in plan mode (ExitPlanMode), the
// plan itself rendered as markdown with approve/reject choices. The text is
// also put in the aria-live status region so it's read out right away,
// while focus moves to the first choice.
function renderPermissionRequest (requestId, request) {
	let isPlan = typeof request.input?.plan === 'string';
	let dialog = startPermissionDialog(t(isPlan ? 'permission.planTitle' : 'permission.title'));
	let firstButton;
	if (isPlan) {
		dialog.appendChild(renderMarkdownMessage(request.input.plan));
		firstButton = appendDialogButton(dialog, t('button.approvePlan'), () => answerPermission(requestId, { behavior: 'allow', updatedInput: request.input }));
		appendDialogButton(dialog, t('button.rejectPlan'), () => answerPermission(requestId, { behavior: 'deny', message: PLAN_REJECTED_MESSAGE }));
		setStatus(t('permission.planTitle'));
	} else {
		let text = describePermissionRequest(request);
		dialog.appendChild(create('p', text));
		firstButton = appendDialogButton(dialog, t('button.allowOnce'), () => answerPermission(requestId, { behavior: 'allow', updatedInput: request.input }));
		appendDialogButton(dialog, t('button.alwaysAllow'), () => {
			if (!allowedTools.includes(request.tool_name)) allowedTools = [...allowedTools, request.tool_name];
			answerPermission(requestId, { behavior: 'allow', updatedInput: request.input });
		});
		appendDialogButton(dialog, t('button.deny'), () => answerPermission(requestId, { behavior: 'deny', message: DENIED_MESSAGE }));
		setStatus(text);
	}
	appendDialogButton(dialog, t('button.denyWithMessage'), () => renderDenyWithMessage(requestId, request));
	if (!dialog.open) dialog.showModal();
	firstButton.focus();
}

// Second step of "deny with a message": the same dialog, now holding a field
// for what Claude should do instead. Back returns to the request's choices.
function renderDenyWithMessage (requestId, request) {
	let dialog = startPermissionDialog(t('permission.denyWithMessageTitle'));
	let form = document.createElement('form');
	let fieldId = 'denyMessageField';
	let label = create('label', t('permission.denyMessageLabel'));
	label.setAttribute('for', fieldId);
	let field = document.createElement('textarea');
	field.id = fieldId;
	field.rows = 4;
	field.cols = 60;
	let sendButton = create('button', t('button.sendDenial'));
	sendButton.type = 'submit';
	form.append(label, field, sendButton);
	appendDialogButton(form, t('button.back'), () => renderPermissionRequest(requestId, request));
	form.addEventListener('submit', event => {
		event.preventDefault();
		let message = field.value.trim();
		if (!message) {
			setStatus(t('status.denyMessageEmpty'));
			field.focus();
			return;
		}
		answerPermission(requestId, { behavior: 'deny', message });
	});
	dialog.appendChild(form);
	field.focus();
}

// AskUserQuestion: one fieldset per question (up to 4), radio buttons — or
// checkboxes for a multiple-choice one — per option, each option's
// description attached with aria-describedby, plus a free "Other" answer.
// Answers go back as updatedInput.answers, keyed by question text (format
// confirmed against the real CLI; several choices are joined with ", ").
function renderUserQuestions (requestId, request) {
	let questions = request.input?.questions ?? [];
	let title = t('question.title', { count: questions.length });
	let dialog = startPermissionDialog(title);
	let form = document.createElement('form');

	let groups = questions.map((question, questionIndex) => {
		let fieldset = document.createElement('fieldset');
		fieldset.appendChild(create('legend', question.question));
		let name = `question${questionIndex}`;
		let type = question.multiSelect ? 'checkbox' : 'radio';

		function addChoice (id, labelText, description) {
			let wrapper = document.createElement('div');
			let input = document.createElement('input');
			input.type = type;
			input.name = name;
			input.id = id;
			let label = create('label', labelText);
			label.setAttribute('for', id);
			wrapper.append(input, label);
			if (description) {
				let descriptionElement = create('span', description);
				descriptionElement.id = `${id}Description`;
				descriptionElement.className = 'option-description';
				input.setAttribute('aria-describedby', descriptionElement.id);
				wrapper.append(descriptionElement);
			}
			fieldset.appendChild(wrapper);
			return input;
		}

		let choices = (question.options ?? []).map((option, optionIndex) => {
			let input = addChoice(`${name}Option${optionIndex}`, option.label, option.description);
			input.value = option.label;
			return input;
		});
		let otherChoice = addChoice(`${name}Other`, t('question.other'));
		let otherField = document.createElement('input');
		otherField.type = 'text';
		otherField.setAttribute('aria-label', t('question.otherAnswer', { question: question.question }));
		// Typing an answer of one's own selects "Other" along with it.
		otherField.addEventListener('input', () => { otherChoice.checked = otherField.value.trim() !== ''; });
		otherChoice.parentElement.appendChild(otherField);
		form.appendChild(fieldset);
		return { question, choices, otherChoice, otherField };
	});

	let answerButton = create('button', t('button.answer'));
	answerButton.type = 'submit';
	form.appendChild(answerButton);
	appendDialogButton(form, t('button.declineAnswer'), () => answerPermission(requestId, { behavior: 'deny', message: QUESTIONS_DECLINED_MESSAGE }));

	form.addEventListener('submit', event => {
		event.preventDefault();
		let answers = {};
		for (let group of groups) {
			let selected = group.choices.filter(input => input.checked).map(input => input.value);
			let other = group.otherField.value.trim();
			if (group.otherChoice.checked && other) selected.push(other);
			if (!selected.length) {
				setStatus(t('status.questionUnanswered', { question: group.question.question }));
				(group.choices[0] ?? group.otherChoice).focus();
				return;
			}
			answers[group.question.question] = selected.join(', ');
		}
		answerPermission(requestId, { behavior: 'allow', updatedInput: { ...request.input, answers } });
	});

	dialog.appendChild(form);
	if (!dialog.open) dialog.showModal();
	setStatus(title);
	(groups[0]?.choices[0] ?? answerButton).focus();
}

// Reusable modal input flow: shows a title, a message/label, a text field
// pre-filled with defaultValue, and OK/Annuler/Fermer. Resolves with the
// entered text, or null if cancelled/closed (including via Escape).
function showInputDialog (title, message, defaultValue = '') {
	return new Promise(resolve => {
		let dialog = document.getElementById('questionArea');
		dialog.textContent = '';
		dialog.oncancel = null;

		function finish (value) {
			dialog.textContent = '';
			if (dialog.open) dialog.close();
			resolve(value);
		}

		let closeButton = create('button', t('button.close'));
		closeButton.type = 'button';
		closeButton.addEventListener('click', () => finish(null));
		dialog.appendChild(closeButton);
		dialog.appendChild(create('h2', title));

		let form = document.createElement('form');
		let fieldId = 'inputDialogField';
		let label = create('label', message);
		label.setAttribute('for', fieldId);
		let field = document.createElement('input');
		field.type = 'text';
		field.id = fieldId;
		field.value = defaultValue;

		let okButton = create('button', t('button.ok'));
		okButton.type = 'submit';
		let cancelButton = create('button', t('button.cancel'));
		cancelButton.type = 'button';
		cancelButton.addEventListener('click', () => finish(null));

		form.appendChild(label);
		form.appendChild(field);
		form.appendChild(okButton);
		form.appendChild(cancelButton);
		form.addEventListener('submit', event => {
			event.preventDefault();
			finish(field.value);
		});
		dialog.appendChild(form);

		dialog.addEventListener('cancel', () => finish(null), { once: true });
		dialog.showModal();
		field.focus();
		field.select();
	});
}

// Reusable modal confirm flow: shows a title, a message, and Confirmer/
// Annuler/Fermer. Resolves with true only if Confirmer was clicked.
function showConfirmDialog (title, message) {
	return new Promise(resolve => {
		let dialog = document.getElementById('questionArea');
		dialog.textContent = '';
		dialog.oncancel = null;

		function finish (value) {
			dialog.textContent = '';
			if (dialog.open) dialog.close();
			resolve(value);
		}

		let closeButton = create('button', t('button.close'));
		closeButton.type = 'button';
		closeButton.addEventListener('click', () => finish(false));
		dialog.appendChild(closeButton);
		dialog.appendChild(create('h2', title));
		dialog.appendChild(create('p', message));

		let confirmButton = create('button', t('button.confirm'));
		confirmButton.type = 'button';
		confirmButton.addEventListener('click', () => finish(true));
		let cancelButton = create('button', t('button.cancel'));
		cancelButton.type = 'button';
		cancelButton.addEventListener('click', () => finish(false));
		dialog.appendChild(confirmButton);
		dialog.appendChild(cancelButton);

		dialog.addEventListener('cancel', () => finish(false), { once: true });
		dialog.showModal();
		confirmButton.focus();
	});
}

// Reusable modal move flow: shows a title, a <select> of every workspace
// currently shown in the list (hidden ones excluded unless "show hidden" is
// on) except the session's current one, and OK/Annuler/Fermer.
// Resolves with the chosen workspace path, or null if cancelled/closed.
function showMoveSessionDialog (currentWorkspacePath) {
	return new Promise(resolve => {
		let dialog = document.getElementById('questionArea');
		dialog.textContent = '';
		dialog.oncancel = null;

		function finish (value) {
			dialog.textContent = '';
			if (dialog.open) dialog.close();
			resolve(value);
		}

		let closeButton = create('button', t('button.close'));
		closeButton.type = 'button';
		closeButton.addEventListener('click', () => finish(null));
		dialog.appendChild(closeButton);
		dialog.appendChild(create('h2', t('dialog.moveSessionTitle')));

		let form = document.createElement('form');
		let fieldId = 'moveSessionTargetField';
		let label = create('label', t('dialog.moveSessionLabel'));
		label.setAttribute('for', fieldId);
		let field = document.createElement('select');
		field.id = fieldId;
		for (let workspace of visibleWorkspaces()) {
			if (workspace.path === currentWorkspacePath) continue;
			let option = document.createElement('option');
			option.value = workspace.path;
			option.textContent = workspaceLabel(workspace.path);
			field.appendChild(option);
		}

		let okButton = create('button', t('button.ok'));
		okButton.type = 'submit';
		let cancelButton = create('button', t('button.cancel'));
		cancelButton.type = 'button';
		cancelButton.addEventListener('click', () => finish(null));

		form.appendChild(label);
		form.appendChild(field);
		form.appendChild(okButton);
		form.appendChild(cancelButton);
		form.addEventListener('submit', event => {
			event.preventDefault();
			finish(field.value || null);
		});
		dialog.appendChild(form);

		dialog.addEventListener('cancel', () => finish(null), { once: true });
		dialog.showModal();
		field.focus();
	});
}

// Describes a tool's input in plain language rather than raw JSON: the
// command for Bash/PowerShell (plus Claude's own one-line description of
// it, when given), the file for Write/Edit/Read, the address for WebFetch.
// Anything else falls back to the tool name alone (no JSON fragment shown).
function describeToolAction (input) {
	if (!input) return '';
	if (typeof input.command === 'string') {
		let detail = t('tool.detail.command', { command: input.command });
		return input.description ? `${detail} ${t('tool.detail.description', { description: input.description })}` : detail;
	}
	if (typeof input.file_path === 'string') return t('tool.detail.file', { path: toProjectRelativePath(input.file_path) });
	if (typeof input.url === 'string') return t('tool.detail.url', { url: input.url });
	return '';
}

function describePermissionRequest (request) {
	let tool = request.display_name || request.tool_name;
	let detail = describeToolAction(request.input);
	return detail ? t('tool.request.withDetail', { tool, detail }) : t('tool.request.plain', { tool });
}

// Strips currentCwd from an absolute path read by a tool, so the "files read"
// list in the tool-use details shows a path relative to the project root
// rather than a full (and much noisier) absolute one. Falls back to the
// original path unchanged if it isn't actually under currentCwd.
function toProjectRelativePath (absolutePath) {
	if (!currentCwd) return absolutePath;
	// currentCwd and a tool's own absolute paths don't necessarily use the same
	// slash style (e.g. a workspace added as "C:/foo/bar" vs. a tool reporting
	// "C:\foo\bar\file.cpp") — compare on a forward-slash-normalized form so
	// the prefix still matches, but keep the original separators of
	// absolutePath in the returned relative path.
	let normalize = p => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	let cwd = currentCwd.replace(/[\\/]+$/, '');
	let normalizedCwd = normalize(currentCwd);
	if (normalize(absolutePath).slice(0, normalizedCwd.length) !== normalizedCwd) return absolutePath;
	return absolutePath.slice(cwd.length).replace(/^[\\/]+/, '');
}

// Classifies one tool_use block for the collapsible tool-use summary (see
// buildToolDetails): a file read, a shell command, or anything else. "Read"
// with a "file_path" input and "command" input (Bash, the only shape
// confirmed so far — see the mock) are the two special-cased shapes; anything
// else falls back to just the tool's name.
function classifyToolUse (name, input) {
	if (name === 'Read' && typeof input?.file_path === 'string') {
		return { kind: 'file', label: toProjectRelativePath(input.file_path) };
	}
	if (typeof input?.command === 'string') return { kind: 'command', label: input.command };
	return { kind: 'other', label: name };
}

function cacheToolUse (message) {
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_use') appendMessage('tool', classifyToolUse(item.name, item.input));
	}
}

// Claude Code writes the auto-generated title to the session's file on disk
// only after the turn ends, not through the stream (see plan.md) — wait a bit
// then fetch it, rather than assume it's there immediately.
async function fetchFreshTitle () {
	await wait(1500);
	let session = await fetchSession(currentCwd, currentSessionId);
	if (session?.title) setSessionTitle(session.title);
	await loadSessionList();
}

function onResult (message) {
	// Starting a new session within the running process ("/clear") ends with
	// an empty result of its own: nothing to show for it.
	if (message.num_turns === 0 && !message.result) return;
	playSound('notify.mp3');
	if (abortRequested && message.is_error) appendMessage('notification', t('message.interrupted'));
	else if (message.result) appendMessage('claude', message.result);
	else appendMessage('error', `(${message.subtype})`);
	abortRequested = false;
	recordTokenUsage(message.usage);
	if (awaitingFreshTitle && !message.is_error) {
		awaitingFreshTitle = false;
		fetchFreshTitle();
	}
}

function onServerMessage (message) {
	if (message.type === 'status') return onStatus(message);
	if (message.type === 'confirm_restart') return onConfirmRestart(message);
	if (message.type === 'error') {
		setStatus(t('status.error'));
		appendMessage('error', message.message);
		return;
	}
	// Permission requests and questions concern whichever session the
	// process runs: Claude is blocked on them either way.
	if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') return enqueuePermissionRequest(message);
	if (message.type === 'control_cancel_request') return cancelPermissionRequest(message.request_id);

	// Everything else is the conversation itself, only shown if it's the
	// session displayed here.
	if (!isFollowingProcess()) return;

	if (message.type === 'assistant') cacheToolUse(message);
	// Acknowledgment that Claude has read a message (sent back when it
	// actually consumes it): worth announcing for one sent while it worked.
	if (message.type === 'user' && message.isReplay && Array.isArray(message.message?.content) && messagesSentWhileBusy > 0) {
		messagesSentWhileBusy--;
		setStatus(t('status.messageReceived'));
		return;
	}
	// Confirmed for real (see plan.md): field is "suggestion", fires after "result".
	if (message.type === 'prompt_suggestion') {
		suggestPrompt(message.suggestion);
		return;
	}
	if (message.type === 'result') onResult(message);
	// Everything else (system/tool events, the duplicate final assistant
	// message...) is only useful for debugging at this stage, and hidden from
	// the log for now. Not removed: still useful when debugging the protocol
	// locally.
	// appendMessage('Debug', JSON.stringify(message));
}

// Why sending a prompt now would stop Claude in the middle of its work:
// it's busy with another workspace ('cwd') or another session ('session'),
// which the single process can only switch to by restarting. null if not.
function pendingRestartReason () {
	if (!isProcessBusy()) return null;
	if (!samePath(processState.cwd, currentCwd)) return 'cwd';
	if (processState.sessionId !== currentSessionId) return 'session';
	return null;
}

function confirmProcessRestart (reason) {
	return showConfirmDialog(t('dialog.restartTitle'), t(`dialog.restartMessage.${reason}`, { workspace: workspaceLabel(processState?.cwd ?? '') }));
}

// Returns false if the payload couldn't be sent at all.
async function sendPrompt (payload) {
	let busyHere = isProcessBusy() && isFollowingProcess();
	if (!payload.sessionId) pendingNewSession = { previousSessionId: processState?.sessionId ?? null };
	lastPromptPayload = payload;
	try {
		await send(payload);
	} catch {
		onSendFailed();
		return false;
	}
	if (busyHere) messagesSentWhileBusy++;
	return true;
}

async function onPromptSubmit (event) {
	let promptForm = event.target;
	let promptField = promptForm.elements.prompt;
	let text = promptField.value;

	event.preventDefault();
	if (!text.trim()) return;

	// Asked here, before anything is sent, rather than after the server
	// refuses: cancelling then simply leaves the prompt in the field.
	let restartReason = pendingRestartReason();
	if (restartReason && !await confirmProcessRestart(restartReason)) return;

	// Only cleared from the field (and added to the log) once actually sent,
	// so a failed send leaves the prompt in place, ready to retry.
	let sent = await sendPrompt({
		type: 'prompt', prompt: text, cwd: currentCwd, sessionId: currentSessionId,
		confirmRestart: Boolean(restartReason), ...getRunOptions(),
	});
	if (!sent) return;
	promptField.value = '';
	appendMessage('you', text);
	if (!currentSessionId) awaitingFreshTitle = true;
}

// The server's own check, in case the process became busy elsewhere between
// the check in onPromptSubmit and the prompt reaching it (another tab).
// Nothing was sent: confirming re-sends the same prompt, cancelling gives
// its text back in the prompt field.
async function onConfirmRestart ({ reason }) {
	let payload = lastPromptPayload;
	if (!payload) return;
	if (await confirmProcessRestart(reason)) {
		await sendPrompt({ ...payload, confirmRestart: true });
		return;
	}
	let promptField = document.getElementById('prompt');
	if (!promptField.value.trim()) promptField.value = payload.prompt;
	setStatus(t('status.promptNotSent'));
}

// Stops the current turn only: the process stays up, ready for the next
// message (see server/cliProcess.js's interrupt()).
async function onAbortClick () {
	abortRequested = true;
	try {
		await send({ type: 'abort' });
	} catch {
		abortRequested = false;
		onSendFailed();
	}
}

// Applied to the running process right away, when it runs the session
// shown here — no need to wait for the next prompt.
function onRunOptionChange () {
	if (currentSessionId) saveRunOptionsForSession(currentSessionId, getRunOptions());
	if (!isFollowingProcess()) return;
	send({ type: 'options', ...getRunOptions() }).catch(onSendFailed);
}

// Resets the conversation view for a brand new (or newly loaded) session,
// without touching the working directory or the workspace list — nor a
// pending permission request or question, which Claude still waits on
// whichever session is displayed.
function resetConversationView () {
	messages = [];
	currentPage = 1;
	renderMessages();
	setStatus('');
}

function startNewSession () {
	resetConversationView();
	currentSessionId = null;
	allowedTools = [];
	pendingNewSession = null;
	messagesSentWhileBusy = 0;
	awaitingFreshTitle = false;
	setSessionTitle(defaultTitle());
	localStorage.removeItem(LAST_SESSION_KEY);
	updateSessionAriaCurrent();
	applyRunOptions(loadRunOptionsForSession(null));
	renderSessionOptions();
	resetTokenUsage();
	renderProcessStatus();
}

// Groups consecutive messages of the same role, same as appendMessage does
// for the live stream, so a resumed history reads the same way.
const ROLE_TO_PREFIX = { user: 'you', assistant: 'claude', tool: 'tool', notification: 'notification' };

// Groups consecutive same-role messages, same as appendMessage does for the
// live stream (including the same exact-repeat dedup — real session files
// have been seen to carry back-to-back assistant entries with identical text,
// same as a retried tool_use during a live run), so a resumed history reads
// the same way. "tool" entries carry a `tool` field ({ kind, label } — see
// history.js's classifyToolUse()) instead of `text`.
function groupMessages (rawMessages) {
	let groups = [];
	for (let message of rawMessages) {
		let prefix = ROLE_TO_PREFIX[message.role] || 'claude';
		let entry = prefix === 'tool' ? message.tool : message.text;
		let last = groups[groups.length - 1];
		let mergingIntoLast = Boolean(last) && last.prefix === prefix;
		let lastEntry = mergingIntoLast ? last.texts[last.texts.length - 1] : undefined;
		if (mergingIntoLast && JSON.stringify(lastEntry) === JSON.stringify(entry)) continue;

		if (mergingIntoLast) last.texts.push(entry);
		else groups.push({ prefix, texts: [entry] });
	}
	return groups;
}

async function resumeSession (sessionId) {
	let session = await fetchSession(currentCwd, sessionId);
	if (!session) return;

	resetConversationView();
	// Reloading the same session (after a lost connection) keeps its
	// "always allow" choices.
	if (session.sessionId !== currentSessionId) {
		allowedTools = [];
		messagesSentWhileBusy = 0;
	}
	currentSessionId = session.sessionId;
	pendingNewSession = null;
	awaitingFreshTitle = false;
	setSessionTitle(session.title || defaultTitle());
	messages = groupMessages(session.messages);
	currentPage = pageCount();
	renderMessages();
	localStorage.setItem(LAST_SESSION_KEY, sessionId);
	updateSessionAriaCurrent();
	applyRunOptions(loadRunOptionsForSession(sessionId) || loadRunOptionsForSession(null));
	// Claude currently runs this very session: show its actual settings.
	if (isFollowingProcess()) applyRunOptions(processState);
	renderSessionOptions();
	resetTokenUsage(session.tokenUsage);
	renderProcessStatus();
}

// Prompts for a new title via the shared input dialog, persists it (as a
// custom-title line, same as a real `claude` rename — see history.js), and
// refreshes the list plus the live H1 if that session is the current one.
async function renameSession (sessionId, currentTitle) {
	let newTitle = await showInputDialog(t('dialog.renameSessionTitle'), t('dialog.renameSessionLabel'), currentTitle);
	if (newTitle === null) return;
	newTitle = newTitle.trim();
	if (!newTitle || newTitle === currentTitle) return;

	let ok = await renameSessionRequest(currentCwd, sessionId, newTitle);
	if (!ok) {
		setStatus(t('status.renameFailed'));
		return;
	}
	if (sessionId === currentSessionId) setSessionTitle(newTitle);
	await loadSessionList();
}

async function duplicateSessionAction (sessionId) {
	let result = await duplicateSessionRequest(currentCwd, sessionId);
	if (!result) {
		setStatus(t('status.duplicateFailed'));
		return;
	}
	await loadSessionList();
}

async function deleteSessionAction (sessionId, title) {
	let confirmed = await showConfirmDialog(
		t('dialog.deleteSessionTitle'),
		t('dialog.deleteSessionMessage', { title }),
	);
	if (!confirmed) return;

	let ok = await deleteSessionRequest(currentCwd, sessionId);
	if (!ok) {
		setStatus(t('status.deleteFailed'));
		return;
	}
	if (sessionId === currentSessionId) startNewSession();
	await loadSessionList();
}

// Moves the session to another workspace's history, then reloads both lists
// (per the user's request) — the workspace list because a workspace only
// known client-side (see loadExtraWorkspaces) may now be known to `claude`
// for real, the session list because the moved session is gone from here.
async function moveSessionAction (sessionId) {
	let targetCwd = await showMoveSessionDialog(currentCwd);
	if (!targetCwd) return;

	let ok = await moveSessionRequest(currentCwd, sessionId, targetCwd);
	if (!ok) {
		setStatus(t('status.moveFailed'));
		return;
	}
	if (sessionId === currentSessionId) startNewSession();
	await loadWorkspaces();
	await loadSessionList();
}

function updateSessionAriaCurrent () {
	for (let button of document.querySelectorAll('#sessionList button[data-session-id]')) {
		if (button.dataset.sessionId === currentSessionId) button.setAttribute('aria-current', 'true');
		else button.removeAttribute('aria-current');
	}
}

// Sessions are fetched once (already sorted newest-first by the server, see
// history.js) and paginated client-side with simple older/newer buttons —
// no page-number input needed here, unlike the message log.
// Overridden from config (sessionsPerPage) once it's fetched in onWindowLoad.
let SESSIONS_PAGE_SIZE = 10;
let allSessions = [];
let sessionsPage = 0;

function renderSessionPage () {
	let list = document.getElementById('sessionList');
	list.textContent = '';
	let start = sessionsPage * SESSIONS_PAGE_SIZE;
	for (let session of allSessions.slice(start, start + SESSIONS_PAGE_SIZE)) {
		// The server leaves the title empty when Claude Code hasn't generated
		// one yet (no ai-title/custom-title/preview on disk) rather than
		// guessing a language-specific placeholder itself — defaultTitle() picks
		// the current UI language's placeholder here instead.
		let title = session.title || defaultTitle();
		// Comma-separated, locale-formatted date (browser's own locale/regional
		// settings — no hardcoded format) rather than parentheses, for clearer
		// screen reader phrasing.
		let label = session.lastTime
			? `${title}, ${new Date(session.lastTime).toLocaleString()}`
			: title;
		let button = create('button', label);
		button.type = 'button';
		button.dataset.sessionId = session.sessionId;
		if (session.sessionId === currentSessionId) button.setAttribute('aria-current', 'true');
		button.addEventListener('click', () => resumeSession(session.sessionId));

		// Collapsed by default: keeps per-session actions out of the way without
		// needing a separate screen.
		let details = document.createElement('details');
		details.appendChild(create('summary', t('details.sessionOptionsFor', { title })));
		let renameButton = create('button', t('button.rename'));
		renameButton.type = 'button';
		renameButton.addEventListener('click', () => renameSession(session.sessionId, title));
		let duplicateButton = create('button', t('button.duplicate'));
		duplicateButton.type = 'button';
		duplicateButton.addEventListener('click', () => duplicateSessionAction(session.sessionId));
		let deleteButton = create('button', t('button.delete'));
		deleteButton.type = 'button';
		deleteButton.addEventListener('click', () => deleteSessionAction(session.sessionId, title));
		let moveButton = create('button', t('button.move'));
		moveButton.type = 'button';
		moveButton.addEventListener('click', () => moveSessionAction(session.sessionId));
		details.appendChild(renameButton);
		details.appendChild(duplicateButton);
		details.appendChild(deleteButton);
		details.appendChild(moveButton);

		let item = document.createElement('li');
		item.appendChild(button);
		item.appendChild(details);
		list.appendChild(item);
	}

	document.getElementById('newerSessionsButton').disabled = sessionsPage <= 0;
	document.getElementById('olderSessionsButton').disabled = start + SESSIONS_PAGE_SIZE >= allSessions.length;
}

function goToSessionsPage (page) {
	sessionsPage = Math.max(0, page);
	renderSessionPage();
}

async function loadSessionList () {
	allSessions = await fetchSessions(currentCwd);
	sessionsPage = 0;
	renderSessionPage();
}

function loadWorkspaceNames () {
	try {
		return JSON.parse(localStorage.getItem(WORKSPACE_NAMES_KEY)) || {};
	} catch {
		return {};
	}
}

function saveWorkspaceNames (names) {
	localStorage.setItem(WORKSPACE_NAMES_KEY, JSON.stringify(names));
}

// Labeled with only the last path segment by default (a `<label>`/`<select>`
// or a text input with a full path read out isn't as easy to scan with a
// screen reader), or a custom name if the user renamed it — the full path is
// kept as a title attribute (tooltip) and used as the actual cwd on click.
function workspaceLabel (workspacePath) {
	let customName = loadWorkspaceNames()[workspacePath];
	if (customName) return customName;
	let segments = workspacePath.split(/[\\/]+/).filter(Boolean);
	return segments[segments.length - 1] || workspacePath;
}

async function renameWorkspace (workspacePath) {
	let newName = await showInputDialog(t('dialog.renameWorkspaceTitle'), t('dialog.renameWorkspaceLabel'), workspaceLabel(workspacePath));
	if (newName === null) return;
	newName = newName.trim();
	if (!newName) return;

	let names = loadWorkspaceNames();
	names[workspacePath] = newName;
	saveWorkspaceNames(names);
	await loadWorkspaces();
}

function updateWorkspaceAriaCurrent () {
	for (let button of document.querySelectorAll('#workspaceList button[data-workspace-path]')) {
		if (button.dataset.workspacePath === currentCwd) button.setAttribute('aria-current', 'true');
		else button.removeAttribute('aria-current');
	}
}

function normalizeWorkspacePath (workspacePath) {
	return workspacePath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

// Hiding a workspace only removes it from this list (a purely client-side
// preference, stored by normalized path): nothing is deleted on disk, and
// "Show hidden workspaces" brings it back.
function loadHiddenWorkspaces () {
	try {
		return JSON.parse(localStorage.getItem(HIDDEN_WORKSPACES_KEY)) || [];
	} catch {
		return [];
	}
}

function isWorkspaceHidden (workspacePath) {
	return loadHiddenWorkspaces().includes(normalizeWorkspacePath(workspacePath));
}

function setWorkspaceHidden (workspacePath, hidden) {
	let key = normalizeWorkspacePath(workspacePath);
	let keys = loadHiddenWorkspaces().filter(k => k !== key);
	if (hidden) keys.push(key);
	localStorage.setItem(HIDDEN_WORKSPACES_KEY, JSON.stringify(keys));
}

let showHiddenWorkspaces = false;

function visibleWorkspaces () {
	return showHiddenWorkspaces ? workspaces : workspaces.filter(workspace => !isWorkspaceHidden(workspace.path));
}

// The list is rebuilt from scratch, which destroys the button that was just
// clicked (and with "show hidden" off, the workspace itself is gone from the
// list): focus goes back to that workspace's own button if it's still shown,
// else to the first one shown, else to the "show hidden" toggle — never left
// on a removed element.
function toggleWorkspaceHidden (workspacePath) {
	let hidden = !isWorkspaceHidden(workspacePath);
	setWorkspaceHidden(workspacePath, hidden);
	renderWorkspacePage();
	let buttons = [...document.querySelectorAll('#workspaceList button[data-workspace-path]')];
	let target = buttons.find(button => button.dataset.workspacePath === workspacePath)
		|| buttons[0]
		|| document.getElementById('showHiddenWorkspacesButton');
	target.focus();
	setStatus(t(hidden ? 'status.workspaceHidden' : 'status.workspaceUnhidden', { name: workspaceLabel(workspacePath) }));
}

function onShowHiddenWorkspacesClick () {
	showHiddenWorkspaces = !showHiddenWorkspaces;
	document.getElementById('showHiddenWorkspacesButton').setAttribute('aria-pressed', String(showHiddenWorkspaces));
	renderWorkspacePage();
}

function loadExtraWorkspaces () {
	try {
		return JSON.parse(localStorage.getItem(EXTRA_WORKSPACES_KEY)) || [];
	} catch {
		return [];
	}
}

function saveExtraWorkspaces (paths) {
	localStorage.setItem(EXTRA_WORKSPACES_KEY, JSON.stringify(paths));
}

// Sessions-list-style pagination — simple older/newer buttons, no page-number
// input — reusing SESSIONS_PAGE_SIZE (same config field as the session list,
// per the user's request). Workspaces already arrive most-recently-used
// first from the server (see history.js's listProjects), except for the
// client-only "extra" ones appended after, which always sort last.
let workspacesPage = 0;

function renderWorkspacePage () {
	let container = document.getElementById('workspaceList');
	container.textContent = '';
	let shown = visibleWorkspaces();
	// The list can shrink under the current page (a workspace just hidden).
	workspacesPage = Math.min(workspacesPage, Math.max(0, Math.ceil(shown.length / SESSIONS_PAGE_SIZE) - 1));
	let start = workspacesPage * SESSIONS_PAGE_SIZE;
	for (let workspace of shown.slice(start, start + SESSIONS_PAGE_SIZE)) {
		let hidden = isWorkspaceHidden(workspace.path);
		// Same comma-separated, locale-formatted date as the session list (see
		// renderSessionPage). Client-only "extra" workspaces have none: no
		// session was ever run there.
		let labelParts = [workspaceLabel(workspace.path)];
		if (hidden) labelParts.push(t('label.hiddenWorkspace'));
		if (workspace.lastUsed) labelParts.push(new Date(workspace.lastUsed).toLocaleString());
		let button = create('button', labelParts.join(', '));
		button.type = 'button';
		button.title = workspace.path;
		button.dataset.workspacePath = workspace.path;
		if (workspace.path === currentCwd) button.setAttribute('aria-current', 'true');
		button.addEventListener('click', () => selectWorkspace(workspace.path));

		let details = document.createElement('details');
		details.appendChild(create('summary', t('details.workspaceOptionsFor', { name: workspaceLabel(workspace.path) })));
		let renameButton = create('button', t('button.rename'));
		renameButton.type = 'button';
		renameButton.addEventListener('click', () => renameWorkspace(workspace.path));
		details.appendChild(renameButton);
		let hideButton = create('button', t(hidden ? 'button.unhideWorkspace' : 'button.hideWorkspace'));
		hideButton.type = 'button';
		hideButton.addEventListener('click', () => toggleWorkspaceHidden(workspace.path));
		details.appendChild(hideButton);

		let item = document.createElement('li');
		item.appendChild(button);
		item.appendChild(details);
		container.appendChild(item);
	}

	document.getElementById('newerWorkspacesButton').disabled = workspacesPage <= 0;
	document.getElementById('olderWorkspacesButton').disabled = start + SESSIONS_PAGE_SIZE >= shown.length;
}

function goToWorkspacesPage (page) {
	workspacesPage = Math.max(0, page);
	renderWorkspacePage();
}

async function loadWorkspaces () {
	let serverWorkspaces = await fetchProjects();
	// Workspaces added manually via "Ajouter un espace de travail" that
	// `claude` doesn't know about yet (no session run there so far) — kept
	// client-side, and dropped from here automatically once the server list
	// picks them up for real.
	let extraPaths = loadExtraWorkspaces()
		.filter(path => !serverWorkspaces.some(workspace => normalizeWorkspacePath(workspace.path) === normalizeWorkspacePath(path)));
	workspaces = [...serverWorkspaces, ...extraPaths.map(path => ({ path }))];

	workspacesPage = 0;
	renderWorkspacePage();
}

async function selectWorkspace (workspacePath) {
	currentCwd = workspacePath;
	startNewSession();
	localStorage.setItem(LAST_WORKSPACE_KEY, workspacePath);
	updateWorkspaceAriaCurrent();
	await loadSessionList();
}

// Server-side native folder browser (see server.js /api/pick-folder) — only
// possible because this app is always self-hosted on the same machine as the
// browser using it. Resolves to the picked path, or null if cancelled.
async function pickFolderNative () {
	let response = await fetch(`/api/pick-folder?lang=${encodeURIComponent(getLanguage())}`, { method: 'POST' });
	if (!response.ok) return null;
	let data = await response.json();
	return data.path || null;
}

// Reuses questionArea for a manual-path entry dialog, with a "Choisir un
// dossier" button between the field and OK that triggers the native picker:
// picking a folder there validates the dialog immediately (as if OK had been
// clicked), and cancelling it closes the dialog immediately (as if Annuler
// had been clicked) — no extra confirmation click needed either way.
function showAddWorkspaceDialog () {
	return new Promise(resolve => {
		let dialog = document.getElementById('questionArea');
		dialog.textContent = '';
		dialog.oncancel = null;

		function finish (value) {
			dialog.textContent = '';
			if (dialog.open) dialog.close();
			resolve(value);
		}

		let closeButton = create('button', t('button.close'));
		closeButton.type = 'button';
		closeButton.addEventListener('click', () => finish(null));
		dialog.appendChild(closeButton);
		dialog.appendChild(create('h2', t('dialog.addWorkspaceTitle')));

		let form = document.createElement('form');
		let fieldId = 'workspacePathField';
		let label = create('label', t('dialog.addWorkspacePathLabel'));
		label.setAttribute('for', fieldId);
		let field = document.createElement('input');
		field.type = 'text';
		field.id = fieldId;

		let pickButton = create('button', t('button.pickFolder'));
		pickButton.type = 'button';
		pickButton.addEventListener('click', async () => {
			pickButton.disabled = true;
			let picked = await pickFolderNative();
			pickButton.disabled = false;
			if (picked) finish(picked);
			else finish(null);
		});

		let okButton = create('button', t('button.ok'));
		okButton.type = 'submit';
		let cancelButton = create('button', t('button.cancel'));
		cancelButton.type = 'button';
		cancelButton.addEventListener('click', () => finish(null));

		form.appendChild(label);
		form.appendChild(field);
		form.appendChild(pickButton);
		form.appendChild(okButton);
		form.appendChild(cancelButton);
		form.addEventListener('submit', event => {
			event.preventDefault();
			finish(field.value.trim() || null);
		});
		dialog.appendChild(form);

		dialog.addEventListener('cancel', () => finish(null), { once: true });
		dialog.showModal();
		field.focus();
	});
}

async function onAddWorkspaceClick () {
	let workspacePath = await showAddWorkspaceDialog();
	if (!workspacePath) return;

	// Adding a workspace back explicitly means it's wanted again.
	if (isWorkspaceHidden(workspacePath)) {
		setWorkspaceHidden(workspacePath, false);
		renderWorkspacePage();
	}

	// Already known (typed or picked a path that matches an existing entry,
	// possibly under a different name/casing/trailing slash): just switch to
	// it rather than adding a redundant duplicate entry.
	let existing = workspaces.find(w => normalizeWorkspacePath(w.path) === normalizeWorkspacePath(workspacePath));
	if (existing) {
		await selectWorkspace(existing.path);
		return;
	}

	let extra = loadExtraWorkspaces();
	extra.push(workspacePath);
	saveExtraWorkspaces(extra);
	await loadWorkspaces();
	await selectWorkspace(workspacePath);
}

// Restores the last-used workspace and session (if still known/available) so
// reopening the app picks up where the user left off, rather than always
// starting blank.
async function restoreLastState () {
	let lastWorkspace = localStorage.getItem(LAST_WORKSPACE_KEY);
	if (!lastWorkspace || !workspaces.some(workspace => workspace.path === lastWorkspace)) {
		await loadSessionList();
		return;
	}

	currentCwd = lastWorkspace;
	updateWorkspaceAriaCurrent();
	await loadSessionList();

	let lastSessionId = localStorage.getItem(LAST_SESSION_KEY);
	if (lastSessionId && allSessions.some(session => session.sessionId === lastSessionId)) {
		await resumeSession(lastSessionId);
	}
}

async function onWindowLoad () {
	await initTheme();
	await initI18n();

	let config = await fetchConfig();
	PAGE_SIZE = config.messagesPerPage;
	SESSIONS_PAGE_SIZE = config.sessionsPerPage;
	PREVIEW_WORD_COUNT = config.titlePreviewWordCount;
	completionSoundEnabled = config.completionSound;
	populateSelect(document.getElementById('modelSelect'), MODELS, 'option.model', config.defaultModel);
	populateSelect(document.getElementById('effortSelect'), EFFORTS, 'option.effort', config.defaultEffort);
	populateSelect(document.getElementById('permissionModeSelect'), PERMISSION_MODES, 'option.permissionMode', config.defaultPermissionMode);

	// Permission requests arriving while another dialog is open wait for it
	// to close (see showNextPermissionRequest).
	let questionArea = document.getElementById('questionArea');
	questionArea.addEventListener('close', () => {
		// The close event fires asynchronously: the next request may already
		// be showing by then.
		if (questionArea.open) return;
		questionArea.removeAttribute('aria-labelledby');
		shownPermissionId = null;
		setTimeout(showNextPermissionRequest, 0);
	});

	for (let id of ['modelSelect', 'effortSelect', 'permissionModeSelect']) {
		document.getElementById(id).addEventListener('change', onRunOptionChange);
	}

	renderProcessStatus();
	connect(onServerMessage, onConnectionLost);

	let promptForm = document.getElementById('promptForm');
	promptForm.addEventListener('submit', onPromptSubmit);

	let abortButton = document.getElementById('abortButton');
	abortButton.addEventListener('click', onAbortClick);

	let addWorkspaceButton = document.getElementById('addWorkspaceButton');
	addWorkspaceButton.addEventListener('click', onAddWorkspaceClick);

	let newSessionButton = document.getElementById('newSessionButton');
	newSessionButton.addEventListener('click', startNewSession);

	let refreshSessionsButton = document.getElementById('refreshSessionsButton');
	refreshSessionsButton.addEventListener('click', loadSessionList);

	document.getElementById('newerSessionsButton').addEventListener('click', () => goToSessionsPage(sessionsPage - 1));
	document.getElementById('olderSessionsButton').addEventListener('click', () => goToSessionsPage(sessionsPage + 1));

	document.getElementById('newerWorkspacesButton').addEventListener('click', () => goToWorkspacesPage(workspacesPage - 1));
	document.getElementById('olderWorkspacesButton').addEventListener('click', () => goToWorkspacesPage(workspacesPage + 1));
	document.getElementById('showHiddenWorkspacesButton').addEventListener('click', onShowHiddenWorkspacesClick);

	document.getElementById('prompt').addEventListener('keydown', event => {
		if (event.key !== 'Enter' || !event.ctrlKey) return;
		event.preventDefault();
		if (!document.getElementById('sendButton').disabled) promptForm.requestSubmit();
	});

	document.getElementById('prevPageButton').addEventListener('click', () => goToPage(currentPage - 1));
	document.getElementById('nextPageButton').addEventListener('click', () => goToPage(currentPage + 1));
	document.getElementById('goToPageButton').addEventListener('click', onGoToPageClick);

	loadWorkspaces().then(restoreLastState);
	renderMessages();
	renderSessionOptions();
}

window.addEventListener('load', onWindowLoad);
