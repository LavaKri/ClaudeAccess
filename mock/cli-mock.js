// Standalone mock of `claude -p --output-format=stream-json --include-partial-messages`.
// Emits one JSON object per line on stdout, shaped after a real captured stream
// (see plan.md step 1), so the server/frontend can be developed without spending
// real usage. Swap for the real `claude` binary once the pipeline is stable.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Responses to permission_request/user_question come back as JSON lines on
// stdin, keyed by the "id" the request was sent with — mirroring the shape of
// the real interactive control protocol (input-format=stream-json), which
// hasn't been captured for real yet, see plan.md.
const pendingResponses = new Map();
const stdinInterface = createInterface({ input: process.stdin });
stdinInterface.on('line', line => {
	try {
		let response = JSON.parse(line);
		let resolve = pendingResponses.get(response.id);
		if (resolve) {
			pendingResponses.delete(response.id);
			resolve(response);
		}
	} catch {
		// Ignore malformed lines.
	}
});

function waitForResponse (id) {
	return new Promise(resolve => pendingResponses.set(id, resolve));
}

const CANNED_RESPONSES = [
	"Bonjour ! Ceci est une réponse simulée du mock de claude CLI, générée localement sans consommer d'usage réel.",
	"Voici une deuxième réponse possible, juste pour varier un peu le contenu affiché pendant les tests.",
	"Réponse simulée numéro trois : le vrai claude sera branché plus tard, une fois le protocole stabilisé.",
];

function parseArgs (argv) {
	let args = { prompt: '', model: 'sonnet', effort: 'medium' };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--prompt') args.prompt = argv[++i] ?? '';
		else if (argv[i] === '--model') args.model = argv[++i] ?? args.model;
		else if (argv[i] === '--effort') args.effort = argv[++i] ?? args.effort;
	}
	return args;
}

// Returns a promise resolved once the write is flushed. On Windows, a pipe's
// stdout write is asynchronous and the process can exit before it completes,
// silently dropping whichever line was written last — awaiting this avoids that.
function emit (obj) {
	return new Promise(resolve => process.stdout.write(JSON.stringify(obj) + '\n', resolve));
}

function wait (ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay (min = 40, max = 160) {
	return Math.floor(min + Math.random() * (max - min));
}

function pickResponse () {
	return CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)];
}

function titleFromPrompt (prompt) {
	let words = prompt.trim().split(/\s+/).slice(0, 6).join(' ');
	return words || 'New session';
}

async function main () {
	let { prompt, model, effort } = parseArgs(process.argv.slice(2));
	let sessionId = randomUUID();
	let messageId = `msg_mock_${randomUUID()}`;

	await emit({
		type: 'system',
		subtype: 'init',
		session_id: sessionId,
		model,
		effort,
		permissionMode: 'default',
		cwd: process.cwd(),
	});

	// Hypothetical event: the real `claude -p` stream-json output has no confirmed
	// mechanism yet to surface an auto-generated session title (see plan.md).
	// `-n`/`--name` was confirmed compatible with `-p` but does not appear in the
	// stream, so this shape is a guess to be corrected once observed for real.
	await emit({
		type: 'session_title',
		session_id: sessionId,
		title: titleFromPrompt(prompt),
	});

	await wait(randomDelay(200, 500));

	// Hypothetical events: neither shape has been confirmed on the real `claude`
	// CLI yet (its interactive control protocol wasn't captured for real, see
	// plan.md). A permission request is a closed question (fixed choices only);
	// a user question is open (predefined options, but a free-text answer is
	// still valid) — the frontend treats the two differently.
	let interactionNote = '';
	let roll = Math.random();
	if (roll < 0.3) {
		let id = randomUUID();
		await emit({
			type: 'permission_request',
			session_id: sessionId,
			id,
			text: 'claude veut exécuter `git commit -am "wip"`. Autoriser ?',
			options: [
				{ id: 'allow_once', label: 'Autoriser une fois' },
				{ id: 'allow_always', label: 'Toujours autoriser' },
				{ id: 'deny', label: 'Refuser' },
			],
		});
		let response = await waitForResponse(id);
		interactionNote = response.optionId === 'deny'
			? " (Permission refusée, je n'ai rien exécuté.)"
			: ' (Permission accordée, commande exécutée.)';
	} else if (roll < 0.6) {
		let id = randomUUID();
		await emit({
			type: 'user_question',
			session_id: sessionId,
			id,
			text: 'Quel style de message de commit préfères-tu ?',
			options: [
				{ id: 'conventional', label: 'Conventional commits' },
				{ id: 'freeform', label: 'Libre' },
			],
		});
		let response = await waitForResponse(id);
		interactionNote = ` (Tu as répondu : "${response.optionId || response.text}".)`;
	}

	await emit({
		type: 'stream_event',
		session_id: sessionId,
		event: {
			type: 'message_start',
			message: { id: messageId, type: 'message', role: 'assistant', model, content: [] },
		},
	});

	await emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	});

	let words = (pickResponse() + interactionNote).split(' ');
	let fullText = '';
	for (let i = 0; i < words.length; i++) {
		let chunk = (i === 0 ? '' : ' ') + words[i];
		fullText += chunk;
		await emit({
			type: 'stream_event',
			session_id: sessionId,
			event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
		});
		await wait(randomDelay());
	}

	await emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'content_block_stop', index: 0 },
	});

	await emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
	});

	await emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'message_stop' },
	});

	await emit({
		type: 'assistant',
		session_id: sessionId,
		message: {
			id: messageId,
			type: 'message',
			role: 'assistant',
			model,
			content: [{ type: 'text', text: fullText }],
		},
	});

	await emit({
		type: 'result',
		subtype: 'success',
		session_id: sessionId,
		result: fullText,
		usage: { input_tokens: prompt.length, output_tokens: fullText.length },
	});

	// Hypothetical event tied to the real --prompt-suggestions flag: its shape
	// (and even whether it fires here) hasn't been confirmed for real yet, see
	// plan.md. Emitted here roughly half the time, to exercise prefilling the
	// prompt field on the frontend without suggesting one on every single turn.
	if (Math.random() < 0.5) {
		await wait(randomDelay(100, 300));
		await emit({
			type: 'prompt_suggestion',
			session_id: sessionId,
			prompt: 'commit ça',
		});
	}

	// Listening on stdin (for permission/question responses) keeps the process
	// alive otherwise, since it's an open handle from Node's perspective.
	stdinInterface.close();
}

main();
