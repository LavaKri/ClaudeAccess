import { create } from './DOMHelpers.js';
import { connect, send } from './WsClient.js';
import { fetchProjects, fetchSessions, fetchSession, renameSession as renameSessionRequest } from './HistoryClient.js';

const DEFAULT_TITLE = 'Claude code Testing';

// The open question currently awaiting an answer (user_question), if any.
let pendingQuestion = null;
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

const PREVIEW_WORD_COUNT = 12;

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

// All messages of the current conversation, paginated for display rather than
// shown as one continuously growing log — a continuously auto-scrolling
// region is exactly the kind of thing that's hard to use with JAWS.
const PAGE_SIZE = 20;
let messages = [];
let currentPage = 1;

function pageCount () {
	return Math.max(1, Math.ceil(messages.length / PAGE_SIZE));
}

function updatePaginationControls () {
	let pages = pageCount();
	document.getElementById('pageInput').value = currentPage;
	document.getElementById('pageInput').max = pages;
	document.getElementById('totalPagesLabel').textContent = `sur ${pages}`;
	document.getElementById('firstPageButton').disabled = currentPage <= 1;
	document.getElementById('prevPageButton').disabled = currentPage <= 1;
	document.getElementById('nextPageButton').disabled = currentPage >= pages;
	document.getElementById('lastPageButton').disabled = currentPage >= pages;
}

// Re-renders only the messages of the current page. Each message is its own
// H2 (heading text: "<prefix>: <preview>"), so JAWS users can navigate
// message-to-message with heading-navigation keys, followed by the full text
// in a paragraph.
function renderMessages () {
	currentPage = Math.min(Math.max(currentPage, 1), pageCount());
	let start = (currentPage - 1) * PAGE_SIZE;

	let messageArea = document.getElementById('messageArea');
	messageArea.textContent = '';
	for (let message of messages.slice(start, start + PAGE_SIZE)) {
		messageArea.appendChild(create('h2', `${message.prefix}: ${previewText(message.text)}`));
		messageArea.appendChild(create('p', message.text));
	}
	updatePaginationControls();
}

function goToPage (page) {
	if (Number.isInteger(page)) currentPage = page;
	renderMessages();
	setStatus(`Page ${currentPage} sur ${pageCount()}`);
}

// Adds a message to the log. If the user was already viewing the last page,
// follows along to the new last page; otherwise leaves their current page
// alone and just updates the pagination controls (page count).
function appendMessage (prefix, text) {
	let wasOnLastPage = currentPage >= pageCount();
	messages.push({ prefix, text });
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
	document.title = title;
	document.getElementById('sessionTitle').textContent = title;
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
	pendingQuestion = null;
	let dialog = document.getElementById('questionArea');
	dialog.oncancel = null;
	dialog.textContent = '';
	if (dialog.open) dialog.close();
}

// Renders the question dialog with a text and a set of option buttons, and
// replicates the text into the aria-live status region so it's read out
// immediately, alongside focus moving to the first option. Escape is blocked
// here (unlike showInputDialog below): a permission request or user question
// must be answered through one of the option buttons.
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

		let closeButton = create('button', 'Fermer');
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

		let okButton = create('button', 'OK');
		okButton.type = 'submit';
		let cancelButton = create('button', 'Annuler');
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

async function answerUserQuestion (optionId) {
	let question = pendingQuestion;
	hideQuestion();
	setWorking(true);
	setStatus('Working...');
	await send({ type: 'user_question_response', id: question.id, optionId });
}

// User questions are open: predefined options are offered as a shortcut, but
// the prompt field also stays available for a free-text answer.
function showUserQuestion (message) {
	pendingQuestion = { id: message.id };

	renderQuestion(message.text, message.options.map(option => ({
		label: option.label,
		onClick: () => answerUserQuestion(option.id),
	})));

	document.getElementById('prompt').readOnly = false;
	document.getElementById('sendButton').disabled = false;
	document.getElementById('abortButton').disabled = false;
}

// Permission requests are a closed question (allow-once / always-allow / deny):
// only the option buttons answer, the prompt field stays unavailable. Unlike
// user_question, there's no live pause on the CLI side — see plan.md: an
// unauthorized tool just comes back denied, and "allowing" it means starting
// a new --resume run with the tool added to --allowed-tools.
function showToolPermissionRequest (toolName, toolUseId) {
	awaitingToolPermission = { toolName, toolUseId };

	renderQuestion(`claude veut utiliser l'outil "${toolName}". Autoriser ?`, [
		{ label: 'Autoriser une fois', onClick: () => resumeWithToolAllowed(toolName, false) },
		{ label: 'Toujours autoriser', onClick: () => resumeWithToolAllowed(toolName, true) },
		{ label: 'Refuser', onClick: denyToolPermission },
	]);

	setWorking(true);
}

function denyToolPermission () {
	awaitingToolPermission = null;
	hideQuestion();
	setWorking(false);
	setStatus('Response finished');
}

// "Always allow" persists the tool for the rest of the session; "allow once"
// only grants it for this immediate retry, without remembering it afterwards.
async function resumeWithToolAllowed (toolName, permanent) {
	awaitingToolPermission = null;
	if (permanent && !allowedTools.includes(toolName)) allowedTools = [...allowedTools, toolName];
	let toolsForThisRun = allowedTools.includes(toolName) ? allowedTools : [...allowedTools, toolName];
	hideQuestion();
	setWorking(true);
	setStatus('Working...');
	// Hidden from the message log: this isn't a message the user actually typed.
	await send({
		type: 'prompt', prompt: 'continue', cwd: currentCwd,
		sessionId: currentSessionId, allowedTools: toolsForThisRun,
		...getRunOptions(),
	});
}

function cacheToolUse (message) {
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_use') {
			toolUseCache.set(item.id, { name: item.name, input: item.input });
			appendMessage('Utilisation de l\'outil', `${item.name} ${JSON.stringify(item.input)}`);
		}
	}
}

// Returns true if this message was a denied tool_result and has been handled,
// so the caller can skip its normal (Debug) display.
function handleIfToolDenied (message) {
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_result' && item.is_error) {
			let toolInfo = toolUseCache.get(item.tool_use_id);
			showToolPermissionRequest(toolInfo?.name ?? 'Tool', item.tool_use_id);
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
	if (message.session_id) currentSessionId = message.session_id;

	if (message.type === 'assistant') cacheToolUse(message);
	if (message.type === 'user' && handleIfToolDenied(message)) return;

	// Hypothetical event, not yet confirmed on the real `claude` CLI: see plan.md.
	if (message.type === 'user_question') {
		showUserQuestion(message);
		return;
	}
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
		setStatus('Response finished');
		appendMessage('Claude a répondu', message.result ?? `(${message.subtype})`);
		if (awaitingFreshTitle && message.subtype !== 'aborted') {
			awaitingFreshTitle = false;
			fetchFreshTitle();
		}
		return;
	}
	if (message.type === 'error') {
		setWorking(false);
		setStatus('Error');
		appendMessage('Error', message.message);
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
	appendMessage('Vous dites', text);

	if (pendingQuestion) {
		let question = pendingQuestion;
		hideQuestion();
		setWorking(true);
		setStatus('Working...');
		await send({ type: 'user_question_response', id: question.id, text });
		return;
	}

	if (!currentSessionId) awaitingFreshTitle = true;
	setWorking(true);
	setStatus('Working...');
	await send({
		type: 'prompt', prompt: text, cwd: currentCwd, sessionId: currentSessionId, allowedTools,
		...getRunOptions(),
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
	setSessionTitle(DEFAULT_TITLE);
}

async function resumeSession (sessionId) {
	let session = await fetchSession(currentCwd, sessionId);
	if (!session) return;

	resetConversationView();
	currentSessionId = session.sessionId;
	allowedTools = [];
	awaitingFreshTitle = false;
	setSessionTitle(session.title);
	messages = session.messages.map(message => ({
		prefix: message.role === 'user' ? 'Vous dites' : 'Claude a répondu',
		text: message.text,
	}));
	currentPage = pageCount();
	renderMessages();
}

// Prompts for a new title via the shared input dialog, persists it (as a
// custom-title line, same as a real `claude` rename — see history.js), and
// refreshes the list plus the live H1 if that session is the current one.
async function renameSession (sessionId, currentTitle) {
	let newTitle = await showInputDialog('Renommer la session', 'Nouveau titre :', currentTitle);
	if (newTitle === null) return;
	newTitle = newTitle.trim();
	if (!newTitle || newTitle === currentTitle) return;

	let ok = await renameSessionRequest(currentCwd, sessionId, newTitle);
	if (!ok) {
		setStatus('Échec du renommage de la session.');
		return;
	}
	if (sessionId === currentSessionId) setSessionTitle(newTitle);
	await loadSessionList();
}

async function loadSessionList () {
	let sessions = await fetchSessions(currentCwd);
	let list = document.getElementById('sessionList');
	list.textContent = '';
	for (let session of sessions) {
		// Comma-separated, locale-formatted date (browser's own locale/regional
		// settings — no hardcoded format) rather than parentheses, for clearer
		// screen reader phrasing.
		let label = session.lastTime
			? `${session.title}, ${new Date(session.lastTime).toLocaleString()}`
			: session.title;
		let button = create('button', label);
		button.type = 'button';
		button.addEventListener('click', () => resumeSession(session.sessionId));

		// Collapsed by default: keeps per-session actions (rename today, delete/
		// archive later) out of the way without needing a separate screen.
		let details = document.createElement('details');
		details.appendChild(create('summary', `Options pour ${session.title}`));
		let renameButton = create('button', 'Renommer');
		renameButton.type = 'button';
		renameButton.addEventListener('click', () => renameSession(session.sessionId, session.title));
		details.appendChild(renameButton);

		let item = document.createElement('li');
		item.appendChild(button);
		item.appendChild(details);
		list.appendChild(item);
	}
}

// Renders one button per known workspace, labeled with only the last path
// segment (a `<label>`/`<select>` or a text input with a full path read out
// isn't as easy to scan with a screen reader) — the full path is kept as a
// title attribute (tooltip) and used as the actual cwd on click.
function workspaceLabel (workspacePath) {
	let segments = workspacePath.split(/[\\/]+/).filter(Boolean);
	return segments[segments.length - 1] || workspacePath;
}

async function loadWorkspaces () {
	workspaces = await fetchProjects();
	let container = document.getElementById('workspaceList');
	container.textContent = '';
	for (let workspace of workspaces) {
		let button = create('button', workspaceLabel(workspace.path));
		button.type = 'button';
		button.title = workspace.path;
		button.addEventListener('click', () => selectWorkspace(workspace.path));
		container.appendChild(button);
	}
}

async function selectWorkspace (workspacePath) {
	currentCwd = workspacePath;
	startNewSession();
	await loadSessionList();
}

// Placeholder: will open a folder-picker popup to add a new workspace not
// already known to `claude` — left as a stub for now (to discuss).
function onAddWorkspaceClick () {
	setStatus('Ajout d’un espace de travail : pas encore implémenté.');
}

function onWindowLoad () {
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

	document.getElementById('firstPageButton').addEventListener('click', () => goToPage(1));
	document.getElementById('prevPageButton').addEventListener('click', () => goToPage(currentPage - 1));
	document.getElementById('nextPageButton').addEventListener('click', () => goToPage(currentPage + 1));
	document.getElementById('lastPageButton').addEventListener('click', () => goToPage(pageCount()));
	document.getElementById('pageInput').addEventListener('change', event => goToPage(Number(event.target.value)));

	loadWorkspaces();
	loadSessionList();
	renderMessages();
}

window.addEventListener('load', onWindowLoad);
