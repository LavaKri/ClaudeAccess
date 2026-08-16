// Standalone mock of `claude -p --output-format=stream-json --include-partial-messages`.
// Emits one JSON object per line on stdout, shaped after a real captured stream
// (see plan.md step 1), so the server/frontend can be developed without spending
// real usage. Swap for the real `claude` binary once the pipeline is stable.

import { randomUUID } from 'node:crypto';

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

function emit (obj) {
	process.stdout.write(JSON.stringify(obj) + '\n');
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

async function main () {
	let { prompt, model, effort } = parseArgs(process.argv.slice(2));
	let sessionId = randomUUID();
	let messageId = `msg_mock_${randomUUID()}`;

	emit({
		type: 'system',
		subtype: 'init',
		session_id: sessionId,
		model,
		effort,
		permissionMode: 'default',
		cwd: process.cwd(),
	});

	await wait(randomDelay(200, 500));

	emit({
		type: 'stream_event',
		session_id: sessionId,
		event: {
			type: 'message_start',
			message: { id: messageId, type: 'message', role: 'assistant', model, content: [] },
		},
	});

	emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
	});

	let words = pickResponse().split(' ');
	let fullText = '';
	for (let i = 0; i < words.length; i++) {
		let chunk = (i === 0 ? '' : ' ') + words[i];
		fullText += chunk;
		emit({
			type: 'stream_event',
			session_id: sessionId,
			event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } },
		});
		await wait(randomDelay());
	}

	emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'content_block_stop', index: 0 },
	});

	emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
	});

	emit({
		type: 'stream_event',
		session_id: sessionId,
		event: { type: 'message_stop' },
	});

	emit({
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

	emit({
		type: 'result',
		subtype: 'success',
		session_id: sessionId,
		result: fullText,
		usage: { input_tokens: prompt.length, output_tokens: fullText.length },
	});
}

main();
