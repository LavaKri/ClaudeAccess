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
	deleteProject as deleteProjectRequest,
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

// Set while a tool-permission prompt is shown, so the "aborted" result that
// follows our own abort() call doesn't reset the UI out from under it.
let awaitingToolPermission = null; // { toolName, toolUseId }

let currentCwd = '';
let currentSessionId = null;
let allowedTools = [];
// Known working directories, loaded once so workspace buttons can show a
// short label while still knowing the full path to switch to.
let workspaces = [];
// True right after starting a brand new (non-resumed) prompt: the real title
// isn't known yet, since Claude Code writes it to disk asynchronously after
// the turn ends — see plan.md. Used to trigger a delayed fetch once done.
let awaitingFreshTitle = false;

// tool_use blocks are cached by id so that when the matching tool_result comes
// back denied, we can show the user which tool was involved.
let toolUseCache = new Map();

function wait (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

// Reads the model/effort/permission-mode selects next to the prompt form, so
// every prompt sent (including the silent "continue" retries after a tool
// permission grant) uses the values currently chosen.
function getRunOptions () {
	return {
		model: document.getElementById('modelSelect').value,
		effort: document.getElementById('effortSelect').value,
		permissionMode: document.getElementById('permissionModeSelect').value,
	};
}

function applyRunOptions (options) {
	if (!options) return;
	if (options.model) document.getElementById('modelSelect').value = options.model;
	if (options.effort) document.getElementById('effortSelect').value = options.effort;
	if (options.permissionMode) document.getElementById('permissionModeSelect').value = options.permissionMode;
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
// The model actually used for the in-flight turn, read off the streamed
// "assistant" message (the only place the CLI reports it) and attached to
// the "claude" group once the turn's "result" arrives.
let lastAssistantModel = null;
// The stream isn't known to report the effort level, so the one requested
// when the prompt was sent is used (history.js reads it from the session file).
let lastRequestedEffort = null;

// Tool-use groups don't count as their own pagination unit (see
// renderMessages) — only "you"/"claude"/"error" groups do.
function countablePageGroups () {
	return messages.filter(group => group.prefix !== 'tool').length;
}

function pageCount () {
	return Math.max(1, Math.ceil(countablePageGroups() / PAGE_SIZE));
}

function updatePaginationControls () {
	let pages = pageCount();
	document.getElementById('pageInput').value = currentPage;
	document.getElementById('pageInput').max = pages;
	document.getElementById('totalPagesLabel').textContent = t('label.totalPages', { count: pages });
	document.getElementById('firstPageButton').disabled = currentPage <= 1;
	document.getElementById('prevPageButton').disabled = currentPage <= 1;
	document.getElementById('nextPageButton').disabled = currentPage >= pages;
	document.getElementById('lastPageButton').disabled = currentPage >= pages;
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
		let headingText = (group.prefix === 'claude' && group.model)
			? t(group.effort ? 'message.prefix.claudeWithModelEffort' : 'message.prefix.claudeWithModel', {
				model: group.model,
				effort: group.effort ? t('option.effort.' + group.effort).toLowerCase() : '',
			})
			:`${t('message.prefix.' + group.prefix)}: ${heading ? heading.title : previewText(group.texts[0])}`;
		messageArea.appendChild(create('h2', headingText));
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
function appendMessage (prefix, text, model, effort) {
	let lastGroup = messages[messages.length - 1];
	let mergingIntoLast = Boolean(lastGroup) && lastGroup.prefix === prefix;
	let lastText = mergingIntoLast ? lastGroup.texts[lastGroup.texts.length - 1] : undefined;
	if (mergingIntoLast && JSON.stringify(lastText) === JSON.stringify(text)) return;

	let wasOnLastPage = currentPage >= pageCount();
	if (mergingIntoLast) {
		lastGroup.texts.push(text);
		if (model) lastGroup.model = model;
		if (effort) lastGroup.effort = effort;
	} else {
		messages.push({ prefix, texts: [text], model, effort });
	}

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

function suggestPrompt (suggestion) {
	document.getElementById('prompt').value = suggestion;
}

// While claude is working (including while a permission request is pending):
// the prompt field is read-only and Send is disabled, so the user can't start
// a second run concurrently; Abort is only enabled then.
function setWorking (working) {
	document.getElementById('prompt').readOnly = working;
	document.getElementById('sendButton').disabled = working;
	document.getElementById('abortButton').disabled = !working;
}

function hideQuestion () {
	let dialog = document.getElementById('questionArea');
	dialog.oncancel = null;
	dialog.textContent = '';
	if (dialog.open) dialog.close();
}

// Renders the question dialog with a text and a set of option buttons, and
// replicates the text into the aria-live status region so it's read out
// immediately, alongside focus moving to the first option. Escape is blocked
// here (unlike showInputDialog below): a permission request must be answered
// through one of the option buttons.
function renderQuestion (text, options) {
	let dialog = document.getElementById('questionArea');
	dialog.textContent = '';
	dialog.appendChild(create('p', text));

	let firstButton = null;
	for (let option of options) {
		let button = create('button', option.label);
		button.type = 'button';
		button.addEventListener('click', option.onClick);
		dialog.appendChild(button);
		firstButton ??= button;
	}
	dialog.oncancel = event => event.preventDefault();
	if (!dialog.open) dialog.showModal();
	setStatus(text);
	firstButton?.focus();
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

// Reusable modal move flow: shows a title, a <select> of every known
// workspace except the session's current one, and OK/Annuler/Fermer.
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
		for (let workspace of workspaces) {
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

// Describes a tool's input in plain language rather than raw JSON — "bash"
// and its "command" input are the only shape confirmed so far (see the mock),
// so that's the one special-cased; anything else falls back to the tool name
// alone (no JSON fragment shown to the user).
function describeToolAction (input) {
	if (input && typeof input.command === 'string') return t('tool.detail.command', { command: input.command });
	return '';
}

// Permission requests are a closed question (allow-once / always-allow / deny):
// only the option buttons answer, the prompt field stays unavailable. There's
// no live pause on the CLI side — see plan.md: an unauthorized tool just comes
// back denied, and "allowing" it means starting a new --resume run with the
// tool added to --allowed-tools.
function showToolPermissionRequest (toolName, toolInput, toolUseId) {
	awaitingToolPermission = { toolName, toolUseId };

	let detail = describeToolAction(toolInput);
	let text = detail
		? t('tool.request.withDetail', { tool: toolName, detail })
		: t('tool.request.plain', { tool: toolName });

	renderQuestion(text, [
		{ label: t('button.allowOnce'), onClick: () => resumeWithToolAllowed(toolName, false) },
		{ label: t('button.alwaysAllow'), onClick: () => resumeWithToolAllowed(toolName, true) },
		{ label: t('button.deny'), onClick: denyToolPermission },
	]);
	playSound('ask.mp3');

	setWorking(true);
}

function denyToolPermission () {
	awaitingToolPermission = null;
	hideQuestion();
	setWorking(false);
	setStatus(t('status.responseFinished'));
}

// "Always allow" persists the tool for the rest of the session; "allow once"
// only grants it for this immediate retry, without remembering it afterwards.
async function resumeWithToolAllowed (toolName, permanent) {
	awaitingToolPermission = null;
	if (permanent && !allowedTools.includes(toolName)) allowedTools = [...allowedTools, toolName];
	let toolsForThisRun = allowedTools.includes(toolName) ? allowedTools : [...allowedTools, toolName];
	hideQuestion();
	setWorking(true);
	setStatus(t('status.working'));
	// Hidden from the message log: this isn't a message the user actually typed.
	let runOptions = getRunOptions();
	lastRequestedEffort = runOptions.effort;
	await send({
		type: 'prompt', prompt: 'continue', cwd: currentCwd,
		sessionId: currentSessionId, allowedTools: toolsForThisRun,
		...runOptions,
	});
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
		if (item.type === 'tool_use') {
			toolUseCache.set(item.id, { name: item.name, input: item.input });
			appendMessage('tool', classifyToolUse(item.name, item.input));
		}
	}
}

// Returns true if this message was a denied tool_result and has been handled,
// so the caller can skip its normal (Debug) display.
function handleIfToolDenied (message) {
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_result' && item.is_error) {
			let toolInfo = toolUseCache.get(item.tool_use_id);
			showToolPermissionRequest(toolInfo?.name ?? 'Tool', toolInfo?.input, item.tool_use_id);
			send({ type: 'abort' });
			return true;
		}
	}
	return false;
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

function onServerMessage (message) {
	if (message.session_id) {
		currentSessionId = message.session_id;
		localStorage.setItem(LAST_SESSION_KEY, currentSessionId);
		saveRunOptionsForSession(currentSessionId, getRunOptions());
		renderSessionOptions();
	}

	if (message.type === 'assistant') {
		cacheToolUse(message);
		if (message.message?.model) lastAssistantModel = message.message.model;
	}
	if (message.type === 'user' && handleIfToolDenied(message)) return;

	// Confirmed for real (see plan.md): field is "suggestion", fires after "result".
	if (message.type === 'prompt_suggestion') {
		suggestPrompt(message.suggestion);
		return;
	}
	if (message.type === 'result') {
		// This is the "aborted" result from our own abort() call while putting
		// up the permission prompt above: ignore it, the prompt stays showing.
		if (awaitingToolPermission) return;
		setWorking(false);
		hideQuestion();
		setStatus(t('status.responseFinished'));
		playSound('notify.mp3');
		appendMessage('claude', message.result ?? `(${message.subtype})`, lastAssistantModel, lastRequestedEffort);
		recordTokenUsage(message.usage);
		if (awaitingFreshTitle && message.subtype !== 'aborted') {
			awaitingFreshTitle = false;
			fetchFreshTitle();
		}
		return;
	}
	if (message.type === 'error') {
		setWorking(false);
		setStatus(t('status.error'));
		appendMessage('error', message.message);
		return;
	}
	// Everything else (streaming deltas, system/tool events, the duplicate final
	// assistant message...) is only useful for debugging at this stage, and
	// hidden from the log for now. Not removed: still useful when debugging the
	// protocol locally.
	// appendMessage('Debug', JSON.stringify(message));
}

async function onPromptSubmit (event) {
	let promptForm = event.target;
	let promptField = promptForm.elements.prompt;
	let text = promptField.value;

	event.preventDefault();
	if (!text.trim()) return;

	promptField.value = '';
	appendMessage('you', text);

	if (!currentSessionId) awaitingFreshTitle = true;
	setWorking(true);
	setStatus(t('status.working'));
	let runOptions = getRunOptions();
	lastRequestedEffort = runOptions.effort;
	await send({
		type: 'prompt', prompt: text, cwd: currentCwd, sessionId: currentSessionId, allowedTools,
		...runOptions,
	});
}

async function onAbortClick () {
	await send({ type: 'abort' });
}

// Resets the conversation view for a brand new (or newly loaded) session,
// without touching the working directory or the workspace list.
function resetConversationView () {
	messages = [];
	currentPage = 1;
	lastAssistantModel = null;
	renderMessages();
	hideQuestion();
	setWorking(false);
	setStatus('');
}

function startNewSession () {
	resetConversationView();
	currentSessionId = null;
	allowedTools = [];
	awaitingFreshTitle = false;
	setSessionTitle(defaultTitle());
	localStorage.removeItem(LAST_SESSION_KEY);
	updateSessionAriaCurrent();
	applyRunOptions(loadRunOptionsForSession(null));
	renderSessionOptions();
	resetTokenUsage();
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

		if (mergingIntoLast) {
			last.texts.push(entry);
			if (message.model) last.model = message.model;
			if (message.effort) last.effort = message.effort;
		} else {
			groups.push({ prefix, texts: [entry], model: message.model, effort: message.effort });
		}
	}
	return groups;
}

async function resumeSession (sessionId) {
	let session = await fetchSession(currentCwd, sessionId);
	if (!session) return;

	resetConversationView();
	currentSessionId = session.sessionId;
	allowedTools = [];
	awaitingFreshTitle = false;
	setSessionTitle(session.title || defaultTitle());
	messages = groupMessages(session.messages);
	currentPage = pageCount();
	renderMessages();
	localStorage.setItem(LAST_SESSION_KEY, sessionId);
	updateSessionAriaCurrent();
	applyRunOptions(loadRunOptionsForSession(sessionId) || loadRunOptionsForSession(null));
	renderSessionOptions();
	resetTokenUsage(session.tokenUsage);
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

// Deletes the workspace's whole history (session files + its ~/.claude.json
// entry — see history.js's deleteProject) after a confirm dialog, same
// pattern as deleteSessionAction. Also drops it from the client-only "extra
// workspaces" list (loadExtraWorkspaces) in case it was never known to
// `claude` for real. Switches to a fresh, unset workspace if the deleted one
// was the current one, since currentCwd would otherwise point at nothing.
async function deleteWorkspaceAction (workspacePath) {
	let name = workspaceLabel(workspacePath);
	let confirmed = await showConfirmDialog(
		t('dialog.deleteWorkspaceTitle'),
		t('dialog.deleteWorkspaceMessage', { name }),
	);
	if (!confirmed) return;

	let ok = await deleteProjectRequest(workspacePath);
	if (!ok) {
		setStatus(t('status.deleteWorkspaceFailed'));
		return;
	}

	saveExtraWorkspaces(loadExtraWorkspaces().filter(path => normalizeWorkspacePath(path) !== normalizeWorkspacePath(workspacePath)));

	let names = loadWorkspaceNames();
	delete names[workspacePath];
	saveWorkspaceNames(names);

	if (normalizeWorkspacePath(workspacePath) === normalizeWorkspacePath(currentCwd)) {
		currentCwd = '';
		localStorage.removeItem(LAST_WORKSPACE_KEY);
		startNewSession();
		await loadSessionList();
	}
	await loadWorkspaces();
}

function updateWorkspaceAriaCurrent () {
	for (let button of document.querySelectorAll('#workspaceList button[data-workspace-path]')) {
		if (button.dataset.workspacePath === currentCwd) button.setAttribute('aria-current', 'true');
		else button.removeAttribute('aria-current');
	}
}

function normalizeWorkspacePath (workspacePath) {
	return workspacePath.replace(/[\\/]+$/, '').toLowerCase();
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
	let start = workspacesPage * SESSIONS_PAGE_SIZE;
	for (let workspace of workspaces.slice(start, start + SESSIONS_PAGE_SIZE)) {
		let button = create('button', workspaceLabel(workspace.path));
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

		let deleteButton = create('button', t('button.delete'));
		deleteButton.type = 'button';
		deleteButton.addEventListener('click', () => deleteWorkspaceAction(workspace.path));
		details.appendChild(deleteButton);

		let item = document.createElement('li');
		item.appendChild(button);
		item.appendChild(details);
		container.appendChild(item);
	}

	document.getElementById('newerWorkspacesButton').disabled = workspacesPage <= 0;
	document.getElementById('olderWorkspacesButton').disabled = start + SESSIONS_PAGE_SIZE >= workspaces.length;
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

	connect(onServerMessage);

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

	document.getElementById('prompt').addEventListener('keydown', event => {
		if (event.key !== 'Enter' || !event.ctrlKey) return;
		event.preventDefault();
		if (!document.getElementById('sendButton').disabled) promptForm.requestSubmit();
	});

	document.getElementById('firstPageButton').addEventListener('click', () => goToPage(1));
	document.getElementById('prevPageButton').addEventListener('click', () => goToPage(currentPage - 1));
	document.getElementById('nextPageButton').addEventListener('click', () => goToPage(currentPage + 1));
	document.getElementById('lastPageButton').addEventListener('click', () => goToPage(pageCount()));
	document.getElementById('pageInput').addEventListener('change', event => goToPage(Number(event.target.value)));

	loadWorkspaces().then(restoreLastState);
	renderMessages();
	renderSessionOptions();
}

window.addEventListener('load', onWindowLoad);
