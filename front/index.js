import { create } from './DOMHelpers.js';
import { connect, send } from './WsClient.js';

// The question/permission currently awaiting an answer, if any: { type, id, isOpenQuestion }.
let pendingQuestion = null;

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

async function answerQuestion (optionId) {
	let question = pendingQuestion;
	hideQuestion();
	setWorking(true);
	setStatus('Working...');
	let responseType = question.type === 'permission_request' ? 'permission_response' : 'user_question_response';
	await send({ type: responseType, id: question.id, optionId });
}

// Permission requests are closed questions (allow/deny, at most a handful of
// fixed choices): only the option buttons can answer, the prompt field stays
// unavailable. User questions are open: predefined options are offered as a
// shortcut, but the prompt field also stays available for a free-text answer.
function showQuestion (message) {
	let isOpenQuestion = message.type === 'user_question';
	pendingQuestion = { type: message.type, id: message.id, isOpenQuestion };

	let questionArea = document.getElementById('questionArea');
	questionArea.textContent = '';
	questionArea.appendChild(create('p', message.text));

	let firstButton = null;
	for (let option of message.options) {
		let button = create('button', option.label);
		button.type = 'button';
		button.addEventListener('click', () => answerQuestion(option.id));
		questionArea.appendChild(button);
		firstButton ??= button;
	}
	questionArea.style.display = 'block';

	// Replicated into the aria-live status region so it's read out immediately,
	// alongside focus moving to the first option.
	setStatus(message.text);

	if (isOpenQuestion) {
		document.getElementById('prompt').readOnly = false;
		document.getElementById('sendButton').disabled = false;
		document.getElementById('abortButton').disabled = false;
	} else {
		setWorking(true);
	}

	firstButton?.focus();
}

function onServerMessage (message) {
	// Hypothetical events, not yet confirmed on the real `claude` CLI: see plan.md.
	if (message.type === 'permission_request' || message.type === 'user_question') {
		showQuestion(message);
		return;
	}
	if (message.type === 'session_title') {
		setSessionTitle(message.title);
		return;
	}
	// Hypothetical event tied to the real --prompt-suggestions flag, shape unconfirmed.
	if (message.type === 'prompt_suggestion') {
		suggestPrompt(message.prompt);
		return;
	}
	if (message.type === 'result') {
		setWorking(false);
		hideQuestion();
		setStatus('Response finished');
		appendMessage('Result', message.result ?? `(${message.subtype})`);
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

	if (pendingQuestion?.isOpenQuestion) {
		let question = pendingQuestion;
		hideQuestion();
		setWorking(true);
		setStatus('Working...');
		await send({ type: 'user_question_response', id: question.id, text });
		return;
	}

	setWorking(true);
	setStatus('Working...');
	await send({ type: 'prompt', prompt: text });
}

async function onAbortClick () {
	await send({ type: 'abort' });
}

function onWindowLoad () {
	connect(onServerMessage);

	let promptForm = document.getElementById('promptForm');
	promptForm.addEventListener('submit', onPromptSubmit);

	let abortButton = document.getElementById('abortButton');
	abortButton.addEventListener('click', onAbortClick);
}

window.addEventListener('load', onWindowLoad);
