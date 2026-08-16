import { create } from './DOMHelpers.js';
import { connect, send } from './WsClient.js';

function appendMessage (label, text) {
	let messageArea = document.getElementById('messageArea');
	let block = create('p', `${label}: ${text}`);
	messageArea.appendChild(block);
	return block;
}

function setSessionTitle (title) {
	document.title = title;
	document.getElementById('sessionTitle').textContent = title;
}

function suggestPrompt (suggestion) {
	document.getElementById('prompt').value = suggestion;
}

// While claude is working: the prompt field is read-only and Send is disabled,
// so the user can't start a second run concurrently; Abort is only enabled then.
function setWorking (working) {
	document.getElementById('prompt').readOnly = working;
	document.getElementById('sendButton').disabled = working;
	document.getElementById('abortButton').disabled = !working;
}

function onServerMessage (message) {
	// Hypothetical event, not yet confirmed on the real `claude` CLI: see plan.md.
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
		appendMessage('Result', message.result ?? `(${message.subtype})`);
		return;
	}
	if (message.type === 'error') {
		setWorking(false);
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
	let prompt = promptField.value;

	event.preventDefault();
	if (!prompt.trim()) return;

	promptField.value = '';
	appendMessage('You', prompt);
	setWorking(true);

	await send({ type: 'prompt', prompt });
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
