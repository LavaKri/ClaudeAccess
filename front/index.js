import { create } from './DOMHelpers.js';
import { sendPrompt } from './WsClient.js';

function appendMessage (label, text) {
	let messageArea = document.getElementById('messageArea');
	let block = create('p', `${label}: ${text}`);
	messageArea.appendChild(block);
	return block;
}

function extractText (message) {
	if (message.type === 'stream_event'
		&& message.event?.type === 'content_block_delta'
		&& message.event.delta?.type === 'text_delta') {
		return message.event.delta.text;
	}
	if (message.type === 'result') return message.result;
	if (message.type === 'error') return message.message;
	return JSON.stringify(message);
}

function onServerMessage (message) {
	appendMessage(message.type, extractText(message));
}

async function onPromptSubmit (event) {
	let promptForm = event.target;
	let promptField = promptForm.elements.prompt;
	let prompt = promptField.value;

	event.preventDefault();
	if (!prompt.trim()) return;

	promptField.value = '';
	appendMessage('you', prompt);

	await sendPrompt({ prompt }, onServerMessage);
}

function onWindowLoad () {
	let promptForm = document.getElementById('promptForm');
	promptForm.addEventListener('submit', onPromptSubmit);
}

window.addEventListener('load', onWindowLoad);
