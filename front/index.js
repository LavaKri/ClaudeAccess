import { create } from './DOMHelpers.js';
import { connect, send } from './WsClient.js';
import { fetchProjects, fetchSessions, fetchSession } from './HistoryClient.js';

const DEFAULT_TITLE = 'Claude code Testing';

// The open question currently awaiting an answer (user_question), if any.
let pendingQuestion = null;
// Set while a tool-permission prompt is shown, so the "aborted" result that
// follows our own abort() call doesn't reset the UI out from under it.
let awaitingToolPermission = null; // { toolName, toolUseId }

let currentCwd = '';
let currentSessionId = null;
let allowedTools = [];
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

function appendMessage (label, text) {
	let messageArea = document.getElementById('messageArea');
	let block = create('p', `${label}: ${text}`);
	messageArea.appendChild(block);
	return block;
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
	let questionArea = document.getElementById('questionArea');
	questionArea.style.display = 'none';
	questionArea.textContent = '';
}

// Renders the question area with a text and a set of option buttons, and
// replicates the text into the aria-live status region so it's read out
// immediately, alongside focus moving to the first option.
function renderQuestion (text, options) {
	let questionArea = document.getElementById('questionArea');
	questionArea.textContent = '';
	questionArea.appendChild(create('p', text));

	let firstButton = null;
	for (let option of options) {
		let button = create('button', option.label);
		button.type = 'button';
		button.addEventListener('click', option.onClick);
		questionArea.appendChild(button);
		firstButton ??= button;
	}
	questionArea.style.display = 'block';
	setStatus(text);
	firstButton?.focus();
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
	});
}

function cacheToolUse (message) {
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_use') toolUseCache.set(item.id, { name: item.name, input: item.input });
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
		appendMessage('Result', message.result ?? `(${message.subtype})`);
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
	// assistant message...) is only useful for debugging at this stage.
	appendMessage('Debug', JSON.stringify(message));
}

async function onPromptSubmit (event) {
	let promptForm = event.target;
	let promptField = promptForm.elements.prompt;
	let text = promptField.value;

	event.preventDefault();
	if (!text.trim()) return;

	promptField.value = '';
	appendMessage('You', text);

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
	await send({ type: 'prompt', prompt: text, cwd: currentCwd, sessionId: currentSessionId, allowedTools });
}

async function onAbortClick () {
	await send({ type: 'abort' });
}

// Resets the conversation view for a brand new (or newly loaded) session,
// without touching the working directory or the recent-projects list.
function resetConversationView () {
	document.getElementById('messageArea').textContent = '';
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
	for (let message of session.messages) {
		appendMessage(message.role === 'user' ? 'You' : 'Result', message.text);
	}
}

async function loadSessionList () {
	let sessions = await fetchSessions(currentCwd);
	let list = document.getElementById('sessionList');
	list.textContent = '';
	for (let session of sessions) {
		let label = session.lastTime
			? `${session.title} (${new Date(session.lastTime).toLocaleString()})`
			: session.title;
		let button = create('button', label);
		button.type = 'button';
		button.addEventListener('click', () => resumeSession(session.sessionId));

		let item = document.createElement('li');
		item.appendChild(button);
		list.appendChild(item);
	}
}

async function loadRecentProjects () {
	let projects = await fetchProjects();
	let datalist = document.getElementById('recentProjects');
	datalist.textContent = '';
	for (let project of projects) {
		let option = document.createElement('option');
		option.value = project.path;
		datalist.appendChild(option);
	}
}

async function onCwdSubmit (event) {
	event.preventDefault();
	currentCwd = document.getElementById('cwd').value.trim();
	startNewSession();
	await loadSessionList();
}

function onWindowLoad () {
	connect(onServerMessage);

	let promptForm = document.getElementById('promptForm');
	promptForm.addEventListener('submit', onPromptSubmit);

	let abortButton = document.getElementById('abortButton');
	abortButton.addEventListener('click', onAbortClick);

	let cwdForm = document.getElementById('cwdForm');
	cwdForm.addEventListener('submit', onCwdSubmit);

	let newSessionButton = document.getElementById('newSessionButton');
	newSessionButton.addEventListener('click', startNewSession);

	let refreshSessionsButton = document.getElementById('refreshSessionsButton');
	refreshSessionsButton.addEventListener('click', loadSessionList);

	loadRecentProjects();
	loadSessionList();
}

window.addEventListener('load', onWindowLoad);
