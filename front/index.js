import { create } from './DOMHelpers.js';
import { initI18n, t, tCount, getLanguage } from './i18n.js';
import { buildPermissionChoices } from './permissionRules.js';
import { initTheme } from './theme.js';
import { fetchConfig } from './ConfigClient.js';
import { MODELS, EFFORTS, PERMISSION_MODES, toolStateInMode, populateSelect } from './runOptions.js';
import { connect, send } from './WsClient.js';
import {
	fetchProjects, fetchHistoryProjects, fetchWorkspaceStore, saveWorkspaceStore, fetchSessionOptions, saveSessionOptions, fetchSessions, fetchSession,
	renameSession as renameSessionRequest,
	deleteSession as deleteSessionRequest,
	deleteProject as deleteProjectRequest,
} from './HistoryClient.js';
import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

// html is left at its default (false): raw HTML in a message is escaped
// rather than inserted, since message text ultimately comes from model
// output and must not be trusted as markup.
const md = new MarkdownIt();

// Legacy browser-side workspace keys: only read once, by
// migrateLegacyWorkspaces(), to fill the server-side workspace list.
const LAST_WORKSPACE_KEY = 'claudeAccessible.lastWorkspace';
const LAST_SESSION_KEY = 'claudeAccessible.lastSessionId';
const WORKSPACE_NAMES_KEY = 'claudeAccessible.workspaceNames';
const HIDDEN_WORKSPACES_KEY = 'claudeAccessible.hiddenWorkspaces';
const EXTRA_WORKSPACES_KEY = 'claudeAccessible.extraWorkspaces';

// Set from config.completionSound in onWindowLoad — governs both sounds
// below, no separate toggle per sound.
let completionSoundEnabled = true;
// Set from config.showHiddenMessages in onWindowLoad: shows the bare
// "continue" prompts and the "No response requested." replies that are
// otherwise hidden as noise, in the history and in the live log alike.
let showHiddenMessages = false;
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
// hookRequestId is set while the CLI waits for the answer (method B, see
// answerHookRequest); null when the CLI has been cut (method A, or a method B
// request that expired) and the answer resumes it instead.
let awaitingToolPermission = null; // { toolName, toolUseId, hookRequestId }
// True while "Deny and explain" has replaced the question by its text field, so
// closing that field isn't taken for a lost question (onQuestionDialogClose).
let explainingDenial = false;
// tool_use ids the user denied through the method B hook during the current
// run: the result lists them in permission_denials too, and they must not be
// asked about again (see handleDeniedAtEnd).
let hookDeniedToolUseIds = new Set();

let currentCwd = '';
let currentSessionId = null;
// "Always allow" answers of the open session ({ rule, tool, label,
// insideWorkspace }), sent as --allowed-tools rules with every prompt.
let alwaysRules = [];
// Known working directories, loaded once so workspace buttons can show a
// short label while still knowing the full path to switch to.
// The user's own workspace list ({ path, name?, lastSessionId? }), kept on the
// server (see persistWorkspaces), and the one selected last.
let workspaces = [];
let lastWorkspace = '';
// True right after starting a brand new (non-resumed) prompt: the real title
// isn't known yet, since Claude Code writes it to disk asynchronously after
// the turn ends — see doc/plan.md. Used to trigger a delayed fetch once done.
let awaitingFreshTitle = false;
// Title to give the branch created by "Send to a new branch", once its first
// turn ends (the session's file only exists by then). Null when none is due.
let pendingBranchTitle = null;

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

// Effort forced for the current run by "Send with low effort" (null = use the
// select). Kept for the silent "continue" retries of that run, and never
// written to the select or to the session's saved run options.
let runEffortOverride = null;

function getRunOptionsForRun () {
	return { ...getRunOptions(), ...(runEffortOverride && { effort: runEffortOverride }) };
}

function applyRunOptions (options) {
	if (!options) return;
	if (options.model) document.getElementById('modelSelect').value = options.model;
	if (options.effort) document.getElementById('effortSelect').value = options.effort;
	if (options.permissionMode) document.getElementById('permissionModeSelect').value = options.permissionMode;
	updatePermissionModeDescription();
	resetAllowedTools();
}

// One-line summary of what the selected permission mode allows, asks or
// denies. Linked to the select through aria-describedby, so a screen reader
// announces it with the selected option rather than as a live update.
function updatePermissionModeDescription () {
	let mode = document.getElementById('permissionModeSelect').value;
	document.getElementById('permissionModeDescription').textContent = t('description.permissionMode.' + mode);
}

// Every change of permission mode (and every session or workspace opening)
// starts the "always allowed" list from scratch: nothing is allowed beyond
// what the mode itself does (MODE_TOOL_STATES), and nothing is ever saved.
function resetAllowedTools () {
	alwaysRules = [];
	updatePermissionChanges();
}

// Extra line under the mode description, only present when the user's "always
// allow" answers go beyond the mode: it names each rule and what the mode
// would have done with its tool. A folder rule inside the workspace adds
// nothing to a mode that already allows edits there. Part of the select's
// description (aria-describedby), not a live region.
function updatePermissionChanges () {
	let mode = document.getElementById('permissionModeSelect').value;
	let beyond = alwaysRules.filter(entry => {
		let state = toolStateInMode(mode, entry.tool);
		return state !== 'allowed' && !(state === 'workspace' && entry.insideWorkspace);
	});
	let line = document.getElementById('permissionModeChanges');
	line.textContent = beyond.length
		? t('description.permissionChanges', {
			tools: beyond.map(entry => `${entry.label} (${t('permission.state.' + toolStateInMode(mode, entry.tool))})`).join(', '),
		})
		: '';
	line.hidden = !beyond.length;
}

// Model/effort/permission-mode remembered per session, on the server (so any
// browser reopens a session the same way). Those of the current workspace are
// loaded with its session list (see loadSessionList), then kept in step with
// every change made to the selects.
let sessionRunOptions = {};
// Config defaults, applied to a brand new session.
let defaultRunOptions = {};

function saveRunOptionsForSession (sessionId, options) {
	if (!sessionId) return;
	sessionRunOptions[sessionId] = options;
	saveSessionOptions(currentCwd, sessionId, options);
}

// Saves the selects' current values for the open session; a session that has no
// id yet is saved once the CLI reports it (see onServerMessage).
function rememberRunOptions () {
	saveRunOptionsForSession(currentSessionId, getRunOptions());
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
// Set when the in-flight turn's reply is only the CLI-written "<synthetic>"
// "No response requested." filler (a synthetic message with real content, like
// a usage-limit notice, doesn't set it).
let syntheticTurn = false;
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
	// A select rather than a number field: JAWS's "next edit field" quick key
	// would otherwise stop on it before reaching the prompt. Options are only
	// rebuilt when the page count changes, so the focused select isn't disturbed.
	let pageSelect = document.getElementById('pageInput');
	if (pageSelect.options.length !== pages) {
		pageSelect.replaceChildren(...Array.from({ length: pages }, (_, i) => new Option(String(i + 1), String(i + 1))));
	}
	pageSelect.value = String(currentPage);
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

// `focusGroup` ('first' | 'last') moves the focus to the heading of that
// message group on the new page, so the Previous / Next buttons (and their
// shortcuts) land the screen reader on the messages rather than leaving it on a
// button that may have just become disabled.
function goToPage (page, focusGroup) {
	if (Number.isInteger(page)) currentPage = page;
	renderMessages();
	setStatus(t('status.page', { page: currentPage, total: pageCount() }));
	if (!focusGroup) return;
	let headings = document.getElementById('messageArea').querySelectorAll('h2');
	let heading = focusGroup === 'last' ? headings[headings.length - 1] : headings[0];
	if (!heading) return;
	heading.tabIndex = -1;
	heading.focus();
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

// One-line live progress of the CLI run, shown below the prompt. Whether it's
// read out by the screen reader is the progressAnnounce option: aria-live is
// toggled on the region itself, so the line is always readable on demand.
function setProgress (text, { silent = false } = {}) {
	let area = document.getElementById('progressArea');
	let line = document.getElementById('progressLine');
	// An unchanged line is left alone: the CLI repeats some steps (a stream of
	// thinking counters, a thinking block right after them...) and rewriting the
	// same text could make the screen reader announce it again.
	if (line.textContent === text) return;
	let live = area.getAttribute('aria-live');
	if (silent && live === 'polite') {
		area.setAttribute('aria-live', 'off');
		setTimeout(() => area.setAttribute('aria-live', live), 300);
	}
	line.textContent = text;
}

function setProgressAnnounce (enabled) {
	document.getElementById('progressArea').setAttribute('aria-live', enabled ? 'polite' : 'off');
}

// Single place that turns a tool_use (name + input) into display data, shared
// by the progress line and the permission request. Tool names are kept as the
// CLI reports them (not translated). `text` is the tool's main parameter:
// a file (project-relative if inside the workspace, otherwise the full path
// with its volume), a command, a search pattern, a URL... `external` is true
// for a file outside the workspace, so each display decides how to flag it.
const TOOL_TEXT_FIELDS = ['command', 'pattern', 'query', 'url', 'description', 'skill'];

function describeTool (name, input) {
	let path = input?.file_path ?? input?.notebook_path;
	if (typeof path === 'string') {
		let text = toProjectRelativePath(path);
		return { tool: name, text, external: /^([a-zA-Z]:|[\\/])/.test(text) };
	}
	let field = TOOL_TEXT_FIELDS.find(key => typeof input?.[key] === 'string');
	if (field) return { tool: name, text: input[field], external: false };
	if (Array.isArray(input?.todos)) return { tool: name, text: t('tool.todos', { count: input.todos.length }), external: false };
	return { tool: name, text: '', external: false };
}

const PROGRESS_TEXT_MAX = 80;

function describeToolStep (name, input) {
	let { tool, text } = describeTool(name, input);
	if (text.length > PROGRESS_TEXT_MAX) text = text.slice(0, PROGRESS_TEXT_MAX) + '…';
	return text ? `${tool} ${text}` : tool;
}

// Maps one streamed CLI message to a progress step, if it carries one.
function updateProgressFromMessage (message) {
	if (message.type === 'system' && message.subtype === 'init') {
		setProgress(t('progress.starting'));
	} else if (message.type === 'system' && message.subtype === 'thinking_tokens') {
		// Sent while the model is still thinking, well before its thinking block
		// is complete: lets "thinking" show up as it happens.
		setProgress(t('progress.thinking'));
	} else if (message.type === 'assistant') {
		let content = message.message?.content ?? [];
		let toolUse = content.findLast(item => item.type === 'tool_use');
		if (toolUse) setProgress(describeToolStep(toolUse.name, toolUse.input));
		else if (content.some(item => item.type === 'thinking')) setProgress(t('progress.thinking'));
		else if (content.some(item => item.type === 'text')) setProgress(t('progress.writing'));
	} else if (message.type === 'user') {
		let result = (message.message?.content ?? []).find(item => item.type === 'tool_result');
		if (result) {
			let tool = toolUseCache.get(result.tool_use_id)?.name ?? '';
			setProgress(t(result.is_error ? 'progress.toolError' : 'progress.toolDone', { tool }));
		}
	}
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

// Options for the session as a whole, shown before the message log. Rename
// reuses the same action as the session list's own options; Copy/Export work
// on the in-memory log directly, so they're available even for a brand new,
// not-yet-saved session.
function renderSessionOptions () {
	let container = document.getElementById('sessionOptionsArea');
	container.textContent = '';

	let details = document.createElement('details');
	details.appendChild(create('summary', t('details.sessionOptions')));

	let renameButton = create('button', t('button.rename'));
	renameButton.type = 'button';
	renameButton.disabled = !currentSessionId;
	renameButton.addEventListener('click', () => renameSession(currentSessionId, currentSessionTitle));

	let copyButton = create('button', t('button.copyAllSession'));
	copyButton.type = 'button';
	copyButton.addEventListener('click', () => copyTextToClipboard(buildSessionMarkdown()));

	let exportButton = create('button', t('button.exportAllSession'));
	exportButton.type = 'button';
	exportButton.addEventListener('click', exportSessionMarkdown);

	details.appendChild(renameButton);
	details.appendChild(copyButton);
	details.appendChild(exportButton);
	container.appendChild(details);
}

function suggestPrompt (suggestion) {
	document.getElementById('prompt').value = suggestion;
}

// While claude is working (including while a permission request is pending):
// the prompt field is read-only and Send is disabled, so the user can't start
// a second run concurrently; Abort is only enabled then.
function setWorking (working) {
	let progressText = working ? t('progress.working') : t('progress.idle');
	// A disabled button drops focus to <body>; hand it to the progress line
	// instead, so the screen reader reads the new state right away. The text is
	// written silently first: the focus already makes it read, and the live
	// region would announce the same change a second time.
	let sendButtonIds = ['sendButton', 'sendLowEffortButton', 'sendBranchButton'];
	if (working && sendButtonIds.includes(document.activeElement?.id)) {
		setProgress(progressText, { silent: true });
		document.getElementById('progressLine').focus();
	} else {
		setProgress(progressText);
	}
	document.getElementById('prompt').readOnly = working;
	for (let id of sendButtonIds) document.getElementById(id).disabled = working;
	document.getElementById('abortButton').disabled = !working;
}

// Opens/closes the shared modal dialog, putting the focus back where it was
// before the dialog opened. Done by hand rather than left to the browser's
// native restore, so it doesn't depend on browser behavior. If that element
// is gone or disabled by then (e.g. the Send button once a run started), the
// focus is left wherever it already is.
let focusBeforeDialog = null;

function openDialog (dialog) {
	if (dialog.open) return;
	focusBeforeDialog = document.activeElement;
	dialog.showModal();
}

function closeDialog (dialog) {
	if (!dialog.open) return;
	dialog.close();
	let target = focusBeforeDialog;
	focusBeforeDialog = null;
	if (target?.isConnected && !target.disabled && target !== document.body) target.focus();
}

function hideQuestion () {
	let dialog = document.getElementById('questionArea');
	document.getElementById('showQuestionButton').hidden = true;
	dialog.oncancel = null;
	dialog.textContent = '';
	closeDialog(dialog);
}

// The question last rendered, so it can be shown again (see
// onQuestionDialogClose).
let lastQuestion = null;

// The question dialog can close while a permission request is still pending:
// the browser closes a modal dialog itself after repeated Escape presses, even
// though renderQuestion blocks Escape. The run is then still waiting for an
// answer with nothing to answer it, so a "Show the permission request" button
// appears next to Abort and takes the focus.
function onQuestionDialogClose () {
	if (explainingDenial) return;
	let button = document.getElementById('showQuestionButton');
	let lost = Boolean(awaitingToolPermission) && Boolean(lastQuestion);
	button.hidden = !lost;
	if (!lost) return;
	setStatus(t('status.questionHidden'));
	button.focus();
}

function showQuestionAgain () {
	if (!awaitingToolPermission || !lastQuestion) return;
	document.getElementById('showQuestionButton').hidden = true;
	renderQuestion(lastQuestion.text, lastQuestion.options, lastQuestion.extraLines);
}

// Renders the question dialog with a text and a set of option buttons, and
// replicates the text into the aria-live status region so it's read out
// immediately, alongside focus moving to the first option. Escape is blocked
// here (unlike showInputDialog below): a permission request must be answered
// through one of the option buttons.
function renderQuestion (text, options, extraLines = []) {
	lastQuestion = { text, options, extraLines };
	let dialog = document.getElementById('questionArea');
	dialog.textContent = '';
	dialog.appendChild(create('p', text));
	for (let line of extraLines) dialog.appendChild(create('p', line));

	let firstButton = null;
	for (let option of options) {
		let button = create('button', option.label);
		button.type = 'button';
		button.addEventListener('click', option.onClick);
		dialog.appendChild(button);
		firstButton ??= button;
	}
	dialog.oncancel = event => event.preventDefault();
	openDialog(dialog);
	setStatus([text, ...extraLines].join(' '));
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
			closeDialog(dialog);
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

		dialog.oncancel = () => finish(null);
		openDialog(dialog);
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
			closeDialog(dialog);
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

		dialog.oncancel = () => finish(false);
		openDialog(dialog);
		confirmButton.focus();
	});
}

// Permission requests are a closed question (allow-once / always-allow / deny):
// only the option buttons answer, the prompt field stays unavailable. Two ways
// to get here (doc/claude-p-usage.md): method A, the CLI denied and has been
// cut, so "allowing" starts a new --resume run with the rule added to
// --allowed-tools; method B (hookRequestId), the CLI waits for the answer,
// sent back through the server. Each button picks its path when clicked: a
// method B request that expires meanwhile falls back to method A.
function showToolPermissionRequest (toolName, toolInput, toolUseId, errorText, hookRequestId = null) {
	awaitingToolPermission = { toolName, toolUseId, hookRequestId };

	// Line 1: the request; line 2: the tool's parameter, if any; then the
	// external-file warning and the CLI's error text.
	let { tool, text, external } = describeTool(toolName, toolInput);
	let extraLines = [];
	if (text) extraLines.push(text);
	if (external) extraLines.push(t('tool.request.externalFile'));
	if (errorText) extraLines.push(t('tool.request.error', { error: errorText }));

	// "Always" is offered scoped first (these commands, this folder), then for
	// the whole tool; "once" only covers the exact denied action.
	let choices = buildPermissionChoices(toolName, toolInput, errorText);
	let options = [{ label: t('button.allowOnce'), onClick: () => grantToolPermission(choices.once, null) }];
	if (choices.scoped) {
		let scoped = scopedRuleEntry(toolName, choices.scoped);
		options.push({ label: t('button.alwaysAllowScope', { scope: scoped.label }), onClick: () => grantToolPermission(choices.once, scoped) });
	}
	options.push({
		label: t('button.alwaysAllowTool', { tool }),
		onClick: () => grantToolPermission(choices.once, { rule: choices.whole, tool: toolName, label: t('permission.rule.tool', { tool }), insideWorkspace: false }),
	});
	options.push({ label: t('button.deny'), onClick: () => refuseToolPermission(null) });
	options.push({ label: t('button.denyExplain'), onClick: denyWithExplanation });

	renderQuestion(t('tool.request.tool', { tool }), options, extraLines);
	playSound('ask.mp3');

	setWorking(true);
	setProgress(t('progress.awaitingPermission'));
}

function grantToolPermission (onceRule, alwaysEntry) {
	if (awaitingToolPermission?.hookRequestId) answerHookRequest(true, alwaysEntry);
	else resumeWithToolAllowed(onceRule, alwaysEntry);
}

// explanation (null for a plain denial) tells Claude what to do instead.
// Method B sends it with the denial, and the waiting CLI goes on with it.
// Method A has no CLI left to tell: the explanation becomes the next prompt.
function refuseToolPermission (explanation) {
	if (awaitingToolPermission?.hookRequestId) {
		answerHookRequest(false, null, explanation);
		return;
	}
	denyToolPermission();
	if (explanation) {
		document.getElementById('prompt').value = explanation;
		document.getElementById('promptForm').requestSubmit(document.getElementById('sendButton'));
	}
}

// "Deny and explain": the question gives way to a text field; cancelling it
// brings the same question back.
async function denyWithExplanation () {
	explainingDenial = true;
	let text = await showInputDialog(t('dialog.denyExplainTitle'), t('dialog.denyExplainLabel'));
	explainingDenial = false;
	if (!awaitingToolPermission) return;
	if (text?.trim()) refuseToolPermission(text.trim());
	else showQuestionAgain();
}

// Method B: the CLI is waiting, so the answer goes straight back to it. "Allow
// once" only lets this one call through; an "always" rule is also given to the
// running CLI (for the rest of this run) and kept for the next messages, as
// with method A.
function answerHookRequest (allow, alwaysEntry, explanation = null) {
	let { hookRequestId } = awaitingToolPermission;
	awaitingToolPermission = null;
	if (alwaysEntry && !alwaysRules.some(entry => entry.rule === alwaysEntry.rule)) {
		alwaysRules = [...alwaysRules, alwaysEntry];
		updatePermissionChanges();
	}
	hideQuestion();
	setWorking(true);
	setStatus('');
	send({
		type: 'permission_response', requestId: hookRequestId, allow,
		rules: allow && alwaysEntry ? [alwaysEntry.rule] : [],
		message: explanation,
	});
}

// Method B request the CLI stopped waiting for (its timeout): it has denied
// the tool and carries on. Cut it, as method A does at a denial, and keep the
// question: answering it now resumes the session the method A way.
function onHookRequestExpired (message) {
	if (awaitingToolPermission?.hookRequestId !== message.requestId) return;
	awaitingToolPermission.hookRequestId = null;
	send({ type: 'abort' });
	setStatus(t('status.permissionExpired'));
}

function denyToolPermission () {
	awaitingToolPermission = null;
	hideQuestion();
	setWorking(false);
	setStatus(t('status.responseFinished'));
}

// Display entry of a scoped "always" rule (see buildPermissionChoices).
function scopedRuleEntry (toolName, scoped) {
	if (scoped.kind === 'commands') {
		return { rule: scoped.rule, tool: toolName, label: t('permission.rule.commands', { prefix: scoped.value }), insideWorkspace: false };
	}
	let root = isWorkspaceRoot(scoped.value);
	let label = root
		? t('permission.rule.workspace')
		: t('permission.rule.folder', { folder: toProjectRelativePath(scoped.value) });
	return { rule: scoped.rule, tool: toolName, label, insideWorkspace: root || isInsideWorkspace(scoped.value) };
}

// `alwaysEntry` (null for "allow once") is kept for the rest of the session;
// `onceRule` only covers this immediate retry. Both go with the retry.
async function resumeWithToolAllowed (onceRule, alwaysEntry) {
	awaitingToolPermission = null;
	if (alwaysEntry && !alwaysRules.some(entry => entry.rule === alwaysEntry.rule)) {
		alwaysRules = [...alwaysRules, alwaysEntry];
		updatePermissionChanges();
	}
	let alwaysList = alwaysRules.map(entry => entry.rule);
	let toolsForThisRun = alwaysList.includes(onceRule) ? alwaysList : [...alwaysList, onceRule];
	runGrantedTools = toolsForThisRun;
	hideQuestion();
	setWorking(true);
	setStatus('');
	// Hidden from the message log, unless hidden messages are shown: this isn't a
	// message the user actually typed.
	if (showHiddenMessages) appendMessage('you', 'continue');
	let runOptions = getRunOptionsForRun();
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
	if (!isInsideWorkspace(absolutePath)) return absolutePath;
	let cwd = currentCwd.replace(/[\\/]+$/, '');
	return absolutePath.slice(cwd.length).replace(/^[\\/]+/, '');
}

// currentCwd and a tool's own absolute paths don't necessarily use the same
// slash style (e.g. a workspace added as "C:/foo/bar" vs. a tool reporting
// "C:\foo\bar\file.cpp") — compare on a forward-slash-normalized form so
// the prefix still matches. Requires a separator right after the prefix so
// "C:/foo/bar2" isn't mistaken for being inside "C:/foo/bar".
function isInsideWorkspace (absolutePath) {
	if (!currentCwd) return false;
	let normalize = p => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	let normalizedCwd = normalize(currentCwd);
	let normalizedPath = normalize(absolutePath);
	return normalizedPath.startsWith(normalizedCwd + '/');
}

function isWorkspaceRoot (absolutePath) {
	if (!currentCwd) return false;
	let normalize = p => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	return normalize(absolutePath) === normalize(currentCwd);
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

// Rules sent with the run in flight (the "always" ones plus the "once" one).
let runGrantedTools = [];

// A denial the rule for exactly this action (or the whole tool) was already
// granted for can't be fixed by allowing it again (protected path, deny rule...).
// A broader rule that didn't cover it ("Bash(npm *)" for another command) still
// gets the question.
function isAlreadyGranted (toolName, toolInput, denialMessage) {
	let granted = new Set([...alwaysRules.map(entry => entry.rule), ...runGrantedTools]);
	return granted.has(toolName) || granted.has(buildPermissionChoices(toolName, toolInput, denialMessage).once);
}

// A permission request is recognised by the CLI's own marker, not by wording:
// right before the error tool_result of every denied tool it emits
// { type: 'system', subtype: 'permission_denied', tool_name, tool_use_id,
// message } (seen on real runs for Write, Edit, Bash and in dontAsk mode,
// whatever the text of the denial). An ordinary tool error ("String to replace
// not found", "File has been modified since read"...) carries no such marker:
// no abort, no popup, the model corrects it itself.
// Returns true if the message was a denial and has been dealt with.
function handleIfPermissionDenied (message) {
	if (message.type !== 'system' || message.subtype !== 'permission_denied') return false;
	// The user's own "Deny" through the method B hook: already answered.
	if (message.decision_reason_type === 'hook') {
		if (message.tool_use_id) hookDeniedToolUseIds.add(message.tool_use_id);
		return true;
	}
	// A question is already open (several denials in the same step): the first
	// one is the one asked about.
	if (awaitingToolPermission) return true;

	let toolInfo = toolUseCache.get(message.tool_use_id);
	let toolName = message.tool_name ?? toolInfo?.name ?? 'Tool';
	if (isAlreadyGranted(toolName, toolInfo?.input, message.message)) {
		// Allowing again would only loop (protected path, deny rule...): show the
		// error instead of asking.
		appendMessage('error', t('error.permissionStillDenied', { tool: toolName, error: message.message ?? '' }));
		return true;
	}
	showToolPermissionRequest(toolName, toolInfo?.input, message.tool_use_id, message.message);
	send({ type: 'abort' });
	return true;
}

// Fallback for a denial the marker above didn't catch (an older CLI without
// it, for instance): the result message lists every denial in
// permission_denials, but only once the run is over. Asks about the first one
// that allowing could still fix.
function handleDeniedAtEnd (message) {
	let userDenied = hookDeniedToolUseIds;
	hookDeniedToolUseIds = new Set();
	let denial = (message.permission_denials ?? []).find(entry => !userDenied.has(entry.tool_use_id) && !isAlreadyGranted(entry.tool_name, entry.tool_input));
	if (!denial) return false;
	showToolPermissionRequest(denial.tool_name, denial.tool_input, denial.tool_use_id, t('tool.request.deniedAtEnd'));
	return true;
}

// Claude Code writes the auto-generated title to the session's file on disk
// only after the turn ends, not through the stream (see doc/plan.md) — wait a bit
// then fetch it, rather than assume it's there immediately.
async function fetchFreshTitle () {
	await wait(1500);
	let session = await fetchSession(currentCwd, currentSessionId);
	if (session?.title) setSessionTitle(session.title);
	await loadSessionList();
}

// Same filler as the history hides (server/history.js): nothing worth a log
// entry, whichever model wrote it — unless hidden messages are shown. When they
// are, the filler turn is an ordinary turn (log entry, status, sound).
function isShowableText (text) {
	let bare = String(text ?? '').trim().toLowerCase();
	return Boolean(bare) && (showHiddenMessages || bare !== 'no response requested.');
}

// Shows each text the model writes as it arrives. The CLI sends every assistant
// text as its own message, often between tool calls; only the last one is also
// carried by the final result, so showing just the result would drop the
// others (and the whole answer when the turn ends on a tool call). Same
// content as the rebuilt history, so a page reload shows no difference.
function showAssistantText (message) {
	// A "<synthetic>" message is written by the CLI itself: when it says
	// something (a usage-limit notice...) it is shown, but not under a model name
	// or effort level that don't exist.
	let synthetic = message.message?.model === '<synthetic>';
	for (let item of message.message?.content ?? []) {
		if (item.type === 'text' && isShowableText(item.text)) {
			appendMessage('claude', item.text, synthetic ? undefined : (message.message?.model ?? lastAssistantModel), synthetic ? undefined : lastRequestedEffort);
		}
	}
}

// Reset moment of a usage window: the time alone when it's today, else date
// and time, in the browser's own locale.
function formatResetTime (resetsAtSeconds) {
	if (!resetsAtSeconds) return '';
	let date = new Date(resetsAtSeconds * 1000);
	let today = date.toDateString() === new Date().toDateString();
	return today
		? t('usage.resetsToday', { time: date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) })
		: t('usage.resetsOn', { date: date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) });
}

// Subscription usage, from the CLI's rate_limit_event (status, overage, one
// line per window: five_hour first, then seven_day and any other the CLI
// reports). No aria-live: rewritten silently after each message, read on demand.
function renderUsage (info) {
	let area = document.getElementById('usageLines');
	if (!info) {
		area.replaceChildren(create('p', t('usage.none')));
		return;
	}
	let knownStatus = ['allowed', 'allowed_warning', 'rejected'].includes(info.status);
	let lines = [knownStatus
		? t('usage.status.' + info.status, { threshold: Math.round((info.surpassedThreshold ?? 0) * 100) })
		: t('usage.status.other', { status: info.status ?? '' })];
	if (info.isUsingOverage) lines.push(t('usage.overage'));
	let windows = Object.entries(info.unifiedWindows ?? {})
		.sort(([a], [b]) => (a === 'five_hour' ? -1 : b === 'five_hour' ? 1 : 0));
	for (let [name, window] of windows) {
		let label = ['five_hour', 'seven_day'].includes(name) ? t('usage.window.' + name) : name;
		lines.push(t('usage.windowLine', {
			label,
			percent: Math.round((window.utilization ?? 0) * 100),
			reset: formatResetTime(window.resetsAt),
		}));
	}
	area.replaceChildren(...lines.map(line => create('p', line)));
}

function onServerMessage (message) {
	if (message.type === 'rate_limit_event') {
		renderUsage(message.rate_limit_info);
		return;
	}
	if (message.type === 'permission_request') {
		showToolPermissionRequest(message.tool_name, message.tool_input, null, null, message.requestId);
		return;
	}
	if (message.type === 'permission_request_expired') {
		onHookRequestExpired(message);
		return;
	}
	if (message.session_id) {
		currentSessionId = message.session_id;
		rememberLastSession(currentSessionId);
		if (!sessionRunOptions[currentSessionId]) rememberRunOptions();
		renderSessionOptions();
	}

	if (message.type === 'assistant') {
		cacheToolUse(message);
		// "<synthetic>" is the CLI's own placeholder model for messages it writes
		// itself. Only the "No response requested." filler (a resume with nothing
		// to continue) is dropped: the turn is then treated as filler. A synthetic
		// message that says something, such as "You've hit your session limit",
		// is shown like any other text.
		if (message.message?.model === '<synthetic>') {
			let saysSomething = (message.message.content ?? []).some(item => item.type === 'text' && isShowableText(item.text));
			if (!saysSomething) syntheticTurn = true;
		} else if (message.message?.model) {
			lastAssistantModel = message.message.model;
		}
		showAssistantText(message);
	}
	if (handleIfPermissionDenied(message)) return;
	// While a permission question is open the CLI is being cut: what it still
	// sends (the denied tool_result...) must not touch the progress line. Its
	// aborted result is handled below.
	if (awaitingToolPermission && message.type !== 'result') return;
	updateProgressFromMessage(message);

	// Confirmed for real (see doc/plan.md): field is "suggestion", fires after "result".
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
		if (syntheticTurn) {
			// Filler turn (see above): back to idle without a log entry or a sound.
			syntheticTurn = false;
			setStatus('');
			return;
		}
		setStatus(t('status.responseFinished'));
		playSound('notify.mp3');
		// The texts written during the turn are already in the log (see
		// showAssistantText), and the final one is repeated by the result: an
		// identical repeat is dropped by appendMessage. An empty result (the turn
		// ended on a tool call, with no closing text) adds nothing.
		let finalText = message.result ?? `(${message.subtype})`;
		if (isShowableText(finalText)) appendMessage('claude', finalText, lastAssistantModel, lastRequestedEffort);
		recordTokenUsage(message.usage);
		if (pendingBranchTitle && message.subtype !== 'aborted') nameBranch();
		if (awaitingFreshTitle && message.subtype !== 'aborted') {
			awaitingFreshTitle = false;
			fetchFreshTitle();
		}
		// Denials the permission_denied marker didn't catch (see handleDeniedAtEnd).
		if (message.subtype !== 'aborted') handleDeniedAtEnd(message);
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

	// Without a session there is nothing to branch from: it is a plain send.
	let fork = event.submitter?.id === 'sendBranchButton' && Boolean(currentSessionId);
	if (fork) pendingBranchTitle = t('session.branchTitle', { title: currentSessionTitle });

	promptField.value = '';
	appendMessage('you', text);

	if (!currentSessionId) awaitingFreshTitle = true;
	// A new message starts a new run: "allow once" grants don't carry over.
	runGrantedTools = [];
	setWorking(true);
	// The progress line now says it; clearing (not rewriting) the status avoids
	// a second, redundant "working" announcement.
	setStatus('');
	runEffortOverride = event.submitter?.id === 'sendLowEffortButton' ? 'low' : null;
	let runOptions = getRunOptionsForRun();
	lastRequestedEffort = runOptions.effort;
	await send({
		type: 'prompt', prompt: text, cwd: currentCwd, sessionId: currentSessionId, fork, allowedTools: alwaysRules.map(entry => entry.rule),
		...runOptions,
	});
}

// Names the branch once its first turn has ended. The new session id reached
// currentSessionId through the stream; the run options were copied to it at
// the same time (see onServerMessage).
async function nameBranch () {
	let title = pendingBranchTitle;
	pendingBranchTitle = null;
	if (await renameSessionRequest(currentCwd, currentSessionId, title)) setSessionTitle(title);
	await loadSessionList();
}

// While a permission question is pending the CLI has already been cut (see
// handleIfPermissionDenied): aborting then means declining the request, which
// also clears the pending state — otherwise the page would keep ignoring the
// next runs' messages as leftovers of the cut CLI.
async function onAbortClick () {
	// Method B: the CLI is still running, waiting for the answer. The server
	// denies the request and stops the CLI; its "aborted" result resets the view.
	if (awaitingToolPermission?.hookRequestId) {
		awaitingToolPermission = null;
		hideQuestion();
		await send({ type: 'abort' });
		return;
	}
	if (awaitingToolPermission) {
		denyToolPermission();
		return;
	}
	await send({ type: 'abort' });
}

// Resets the conversation view for a brand new (or newly loaded) session,
// without touching the working directory or the workspace list.
function resetConversationView () {
	messages = [];
	currentPage = 1;
	lastAssistantModel = null;
	renderMessages();
	// A question left open belongs to the run of the previous view.
	awaitingToolPermission = null;
	hideQuestion();
	setWorking(false);
	setStatus('');
}

function startNewSession () {
	resetConversationView();
	currentSessionId = null;
	resetAllowedTools();
	awaitingFreshTitle = false;
	pendingBranchTitle = null;
	setSessionTitle(defaultTitle());
	rememberLastSession(null);
	updateSessionAriaCurrent();
	applyRunOptions(defaultRunOptions);
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
// history.js's classifyToolUse()) instead of `text`. Entries flagged `hidden`
// (noise, see history.js) are left out unless hidden messages are shown.
function groupMessages (rawMessages) {
	let groups = [];
	for (let message of rawMessages) {
		if (message.hidden && !showHiddenMessages) continue;
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
	resetAllowedTools();
	awaitingFreshTitle = false;
	pendingBranchTitle = null;
	setSessionTitle(session.title || defaultTitle());
	messages = groupMessages(session.messages);
	currentPage = pageCount();
	renderMessages();
	rememberLastSession(sessionId);
	updateSessionAriaCurrent();
	// What was last chosen for this session (stored on the server); a session
	// that has none yet falls back to what its file says it was last run with,
	// then to the defaults.
	applyRunOptions({
		...defaultRunOptions,
		...runOptionsFromSession(session.runOptions),
		...sessionRunOptions[sessionId],
	});
	renderSessionOptions();
	resetTokenUsage(session.tokenUsage);
}

// Maps the options recorded in a session file to the selects' values: the file
// holds the full model id (e.g. "claude-sonnet-5-5") while the select uses
// aliases ("sonnet"); values the selects don't offer are ignored.
function runOptionsFromSession (recorded) {
	let options = {};
	let model = MODELS.find(alias => recorded?.model?.includes(alias));
	if (model) options.model = model;
	if (EFFORTS.includes(recorded?.effort)) options.effort = recorded.effort;
	if (PERMISSION_MODES.includes(recorded?.permissionMode)) options.permissionMode = recorded.permissionMode;
	return options;
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

// Messages of a listed session that its log would show: tool uses (collapsed
// details, not messages) are left out, and so are the hidden ones unless the
// showHiddenMessages option is on — same rule as groupMessages().
function displayableMessageCount (session) {
	return (session.messages ?? []).filter(message => message.role !== 'tool' && (showHiddenMessages || !message.hidden)).length;
}

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
		let countText = tCount('session.messageCount', displayableMessageCount(session));
		let label = session.lastTime
			? `${title}, ${new Date(session.lastTime).toLocaleString()}, ${countText}`
			: `${title}, ${countText}`;
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
		let deleteButton = create('button', t('button.delete'));
		deleteButton.type = 'button';
		deleteButton.addEventListener('click', () => deleteSessionAction(session.sessionId, title));
		details.appendChild(renameButton);
		details.appendChild(deleteButton);

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
	// Listing makes the server forget the options of vanished sessions, so the
	// options are fetched after it.
	allSessions = await fetchSessions(currentCwd);
	sessionRunOptions = await fetchSessionOptions(currentCwd);
	sessionsPage = 0;
	renderSessionPage();
}

// The workspace list and the UI state tied to each entry (custom name, last
// session) live on the server (server/workspaces.js), not in this browser:
// saved whole after every change.
function persistWorkspaces () {
	return saveWorkspaceStore({ workspaces, lastWorkspace });
}

function findWorkspace (workspacePath) {
	if (!workspacePath) return undefined;
	let normalized = normalizeWorkspacePath(workspacePath);
	return workspaces.find(workspace => normalizeWorkspacePath(workspace.path) === normalized);
}

// Remembers (or, with null, forgets) the last session opened in the current
// workspace, so reopening the app can pick up where the user left off.
function rememberLastSession (sessionId) {
	let entry = findWorkspace(currentCwd);
	if (!entry || (entry.lastSessionId || null) === (sessionId || null)) return;
	if (sessionId) entry.lastSessionId = sessionId;
	else delete entry.lastSessionId;
	persistWorkspaces();
}

// Labeled with only the last path segment by default (a `<label>`/`<select>`
// or a text input with a full path read out isn't as easy to scan with a
// screen reader), or a custom name if the user renamed it — the full path is
// kept as a title attribute (tooltip) and used as the actual cwd on click.
function workspaceLabel (workspacePath) {
	let customName = findWorkspace(workspacePath)?.name;
	if (customName) return customName;
	let segments = workspacePath.split(/[\\/]+/).filter(Boolean);
	return segments[segments.length - 1] || workspacePath;
}

async function renameWorkspace (workspacePath) {
	let newName = await showInputDialog(t('dialog.renameWorkspaceTitle'), t('dialog.renameWorkspaceLabel'), workspaceLabel(workspacePath));
	if (newName === null) return;
	newName = newName.trim();
	if (!newName) return;

	let entry = findWorkspace(workspacePath);
	if (!entry) return;
	entry.name = newName;
	await persistWorkspaces();
	renderWorkspacePage();
}

// Deletes the workspace's whole history (session files + its ~/.claude.json
// entry — see history.js's deleteProject) after a confirm dialog, same
// pattern as deleteSessionAction, then drops it from the workspace list too.
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
	await dropWorkspaceFromList(workspacePath);
}

// Removes the workspace from the interface only: its history on disk is left
// untouched (unlike deleteWorkspaceAction). The "existing workspaces" picker
// can bring it back.
async function removeWorkspaceFromList (workspacePath) {
	let name = workspaceLabel(workspacePath);
	await dropWorkspaceFromList(workspacePath);
	setStatus(t('status.workspaceRemoved', { name }));
}

// Takes the entry out of the saved list. Switches to a fresh, unset workspace
// if it was the current one, since currentCwd would otherwise point at nothing.
async function dropWorkspaceFromList (workspacePath) {
	let normalized = normalizeWorkspacePath(workspacePath);
	workspaces = workspaces.filter(workspace => normalizeWorkspacePath(workspace.path) !== normalized);
	if (lastWorkspace && normalizeWorkspacePath(lastWorkspace) === normalized) lastWorkspace = '';
	await persistWorkspaces();

	if (normalized === normalizeWorkspacePath(currentCwd)) {
		currentCwd = '';
		startNewSession();
		await loadSessionList();
	}
	workspacesPage = Math.min(workspacesPage, Math.max(0, Math.ceil(workspaces.length / SESSIONS_PAGE_SIZE) - 1));
	renderWorkspacePage();
}

function updateWorkspaceAriaCurrent () {
	for (let button of document.querySelectorAll('#workspaceList button[data-workspace-path]')) {
		if (button.dataset.workspacePath === currentCwd) button.setAttribute('aria-current', 'true');
		else button.removeAttribute('aria-current');
	}
}

// Same path whatever the slash style, case or trailing separator.
function normalizeWorkspacePath (workspacePath) {
	return workspacePath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

// Sessions-list-style pagination — simple older/newer buttons, no page-number
// input — reusing SESSIONS_PAGE_SIZE (same config field as the session list,
// per the user's request). Workspaces keep the order the user added them in.
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

		let removeButton = create('button', t('button.removeFromList'));
		removeButton.type = 'button';
		removeButton.addEventListener('click', () => removeWorkspaceFromList(workspace.path));
		details.appendChild(removeButton);

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

// One-time migration: older versions kept the workspace list, custom names and
// last workspace/session in this browser's localStorage, merged with the
// folders `claude` lists in ~/.claude.json. Builds the server-side store from
// exactly what that browser showed (known folders + manually added ones, minus
// the hidden ones) and saves it. The old keys are left in place, unused.
async function migrateLegacyWorkspaces () {
	let readJson = (key, fallback) => {
		try {
			return JSON.parse(localStorage.getItem(key)) ?? fallback;
		} catch {
			return fallback;
		}
	};
	let names = readJson(WORKSPACE_NAMES_KEY, {});
	let hidden = readJson(HIDDEN_WORKSPACES_KEY, []).map(normalizeWorkspacePath);
	let extra = readJson(EXTRA_WORKSPACES_KEY, []);
	let known = (await fetchProjects()).map(project => project.path);

	let paths = [];
	for (let candidate of [...known, ...extra]) {
		let normalized = normalizeWorkspacePath(candidate);
		if (hidden.includes(normalized) || paths.some(path => normalizeWorkspacePath(path) === normalized)) continue;
		paths.push(candidate);
	}

	let savedWorkspace = localStorage.getItem(LAST_WORKSPACE_KEY) || '';
	let savedSession = localStorage.getItem(LAST_SESSION_KEY) || '';
	let migrated = paths.map(workspacePath => {
		let entry = { path: workspacePath };
		if (names[workspacePath]) entry.name = names[workspacePath];
		if (savedSession && savedWorkspace && normalizeWorkspacePath(workspacePath) === normalizeWorkspacePath(savedWorkspace)) {
			entry.lastSessionId = savedSession;
		}
		return entry;
	});
	let store = {
		workspaces: migrated,
		lastWorkspace: migrated.some(entry => normalizeWorkspacePath(entry.path) === normalizeWorkspacePath(savedWorkspace)) ? savedWorkspace : '',
	};
	await saveWorkspaceStore(store);
	return store;
}

// Loads the user's workspace list from the server (migrating the legacy
// browser-side data the first time, when the server has no list yet).
async function loadWorkspaces () {
	let store = await fetchWorkspaceStore();
	if (!store.exists) store = await migrateLegacyWorkspaces();
	workspaces = store.workspaces;
	lastWorkspace = store.lastWorkspace;
	workspacesPage = 0;
	renderWorkspacePage();
}

async function selectWorkspace (workspacePath) {
	// Read before startNewSession(), which forgets the current workspace's last
	// session (and currentCwd is already the new workspace by then).
	let lastSessionId = findWorkspace(workspacePath)?.lastSessionId;
	currentCwd = workspacePath;
	startNewSession();
	lastWorkspace = workspacePath;
	persistWorkspaces();
	updateWorkspaceAriaCurrent();
	await loadSessionList();
	// Reopen the session this workspace was last on; if it's unknown or gone,
	// the most recent one (the list arrives newest first) rather than leaving a
	// blank conversation with nothing selected.
	let session = allSessions.find(item => item.sessionId === lastSessionId) ?? allSessions[0];
	if (session) await resumeSession(session.sessionId);
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
			closeDialog(dialog);
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

		dialog.oncancel = () => finish(null);
		openDialog(dialog);
		field.focus();
	});
}

async function onAddWorkspaceClick () {
	let workspacePath = await showAddWorkspaceDialog();
	if (workspacePath) await addWorkspace(workspacePath);
}

// Lists the history folders Claude Code has on disk that aren't in the
// workspace list yet, and lets the user add one. Nothing is added unless
// picked: the list is never merged into the sidebar automatically.
function showExistingWorkspacesDialog (candidates) {
	return new Promise(resolve => {
		let dialog = document.getElementById('questionArea');
		dialog.textContent = '';
		dialog.oncancel = null;

		function finish (value) {
			dialog.textContent = '';
			closeDialog(dialog);
			resolve(value);
		}

		let closeButton = create('button', t('button.close'));
		closeButton.type = 'button';
		closeButton.addEventListener('click', () => finish(null));
		dialog.appendChild(closeButton);
		dialog.appendChild(create('h2', t('dialog.existingWorkspacesTitle')));

		let firstFocus = closeButton;
		if (!candidates.length) {
			dialog.appendChild(create('p', t('dialog.existingWorkspacesNone')));
		} else {
			dialog.appendChild(create('p', t('dialog.existingWorkspacesHint')));
			let list = document.createElement('ul');
			for (let candidate of candidates) {
				let button = create('button', candidate.path);
				button.type = 'button';
				button.addEventListener('click', () => finish(candidate.path));
				let item = document.createElement('li');
				item.appendChild(button);
				list.appendChild(item);
				if (firstFocus === closeButton) firstFocus = button;
			}
			dialog.appendChild(list);
		}

		dialog.oncancel = () => finish(null);
		openDialog(dialog);
		firstFocus.focus();
	});
}

async function onExistingWorkspacesClick () {
	let found = await fetchHistoryProjects();
	let candidates = found.filter(project => !workspaces.some(w => normalizeWorkspacePath(w.path) === normalizeWorkspacePath(project.path)));
	let workspacePath = await showExistingWorkspacesDialog(candidates);
	if (workspacePath) await addWorkspace(workspacePath);
}

async function addWorkspace (workspacePath) {
	// Already known (typed or picked a path that matches an existing entry,
	// possibly under a different name/casing/trailing slash): just switch to
	// it rather than adding a redundant duplicate entry.
	let existing = findWorkspace(workspacePath);
	if (existing) {
		await selectWorkspace(existing.path);
		return;
	}

	workspaces.push({ path: workspacePath });
	await persistWorkspaces();
	workspacesPage = Math.floor((workspaces.length - 1) / SESSIONS_PAGE_SIZE);
	renderWorkspacePage();
	await selectWorkspace(workspacePath);
}

// Restores the last-used workspace and session (if still known/available) so
// reopening the app picks up where the user left off, rather than always
// starting blank.
async function restoreLastState () {
	let entry = findWorkspace(lastWorkspace);
	if (!entry) {
		await loadSessionList();
		return;
	}

	currentCwd = entry.path;
	updateWorkspaceAriaCurrent();
	await loadSessionList();

	let lastSessionId = entry.lastSessionId;
	if (lastSessionId && allSessions.some(session => session.sessionId === lastSessionId)) {
		await resumeSession(lastSessionId);
	}
}

async function onWindowLoad () {
	await initTheme();
	await initI18n();

	// Last values the server saw, so the region isn't empty until the next message.
	fetch('/api/usage-limits').then(response => response.json()).then(renderUsage).catch(() => renderUsage(null));

	let config = await fetchConfig();
	PAGE_SIZE = config.messagesPerPage;
	SESSIONS_PAGE_SIZE = config.sessionsPerPage;
	PREVIEW_WORD_COUNT = config.titlePreviewWordCount;
	completionSoundEnabled = config.completionSound;
	showHiddenMessages = config.showHiddenMessages;
	setProgressAnnounce(config.progressAnnounce);
	setProgress(t('progress.idle'));
	populateSelect(document.getElementById('modelSelect'), MODELS, 'option.model', config.defaultModel);
	populateSelect(document.getElementById('effortSelect'), EFFORTS, 'option.effort', config.defaultEffort);
	populateSelect(document.getElementById('permissionModeSelect'), PERMISSION_MODES, 'option.permissionMode', config.defaultPermissionMode);
	defaultRunOptions = getRunOptions();
	document.getElementById('permissionModeSelect').addEventListener('change', () => {
		updatePermissionModeDescription();
		resetAllowedTools();
	});
	for (let id of ['modelSelect', 'effortSelect', 'permissionModeSelect']) {
		document.getElementById(id).addEventListener('change', rememberRunOptions);
	}
	updatePermissionModeDescription();

	connect(onServerMessage);

	let promptForm = document.getElementById('promptForm');
	promptForm.addEventListener('submit', onPromptSubmit);

	let abortButton = document.getElementById('abortButton');
	abortButton.addEventListener('click', onAbortClick);
	document.getElementById('showQuestionButton').addEventListener('click', showQuestionAgain);
	document.getElementById('questionArea').addEventListener('close', onQuestionDialogClose);

	let addWorkspaceButton = document.getElementById('addWorkspaceButton');
	addWorkspaceButton.addEventListener('click', onAddWorkspaceClick);
	document.getElementById('existingWorkspacesButton').addEventListener('click', onExistingWorkspacesClick);

	let newSessionButton = document.getElementById('newSessionButton');
	newSessionButton.addEventListener('click', startNewSession);

	let refreshSessionsButton = document.getElementById('refreshSessionsButton');
	refreshSessionsButton.addEventListener('click', loadSessionList);

	document.getElementById('newerSessionsButton').addEventListener('click', () => goToSessionsPage(sessionsPage - 1));
	document.getElementById('olderSessionsButton').addEventListener('click', () => goToSessionsPage(sessionsPage + 1));

	document.getElementById('newerWorkspacesButton').addEventListener('click', () => goToWorkspacesPage(workspacesPage - 1));
	document.getElementById('olderWorkspacesButton').addEventListener('click', () => goToWorkspacesPage(workspacesPage + 1));

	document.getElementById('prompt').addEventListener('keydown', event => {
		if (event.key !== 'Enter') return;
		// Ctrl+Enter sends; Shift+Enter sends with low effort.
		let sender = event.ctrlKey ? document.getElementById('sendButton')
			: event.shiftKey ? document.getElementById('sendLowEffortButton')
			: null;
		if (!sender) return;
		event.preventDefault();
		if (!sender.disabled) promptForm.requestSubmit(sender);
	});

	document.getElementById('firstPageButton').addEventListener('click', () => goToPage(1));
	document.getElementById('prevPageButton').addEventListener('click', () => goToPage(currentPage - 1, 'last'));
	document.getElementById('nextPageButton').addEventListener('click', () => goToPage(currentPage + 1, 'first'));
	// Alt+PageUp / Alt+PageDown: same as the Previous / Next page buttons, from anywhere.
	document.addEventListener('keydown', event => {
		if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return;
		let id = event.key === 'PageUp' ? 'prevPageButton' : event.key === 'PageDown' ? 'nextPageButton' : null;
		if (!id) return;
		event.preventDefault();
		let button = document.getElementById(id);
		if (!button.disabled) button.click();
	});
	document.getElementById('lastPageButton').addEventListener('click', () => goToPage(pageCount()));
	document.getElementById('pageInput').addEventListener('change', event => {
		let page = Number(event.target.value);
		// Ignore a change that doesn't actually move to another page (or isn't a
		// number): it would only re-render the current page for nothing.
		if (!Number.isInteger(page) || page === currentPage) return;
		goToPage(page);
	});

	loadWorkspaces().then(restoreLastState);
	renderMessages();
	renderSessionOptions();
}

window.addEventListener('load', onWindowLoad);
