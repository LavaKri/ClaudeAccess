// Standalone mock of `claude -p --output-format=stream-json --include-partial-messages`.
// Emits one JSON object per line on stdout, shaped after a real captured stream
// (see plan.md step 1), so the server/frontend can be developed without spending
// real usage. Swap for the real `claude` binary once the pipeline is stable.
//
// Permission handling follows the pattern confirmed by reading claude-code-webui
// (see plan.md): there is no live pause/resume within a single run. An
// unauthorized tool simply comes back as a `tool_result` with `is_error: true`;
// the caller is expected to detect that, then start a *new* run with `--resume`
// and the tool added to `--allowed-tools`.

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

// Responses to user_question come back as JSON lines on stdin, keyed by the
// "id" the request was sent with — mirroring the shape of the real
// interactive control protocol (input-format=stream-json), which hasn't been
// captured for real yet, see plan.md. Permission requests no longer use this:
// see the note above.
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
	let args = { prompt: '', model: 'sonnet', effort: 'medium', resume: '', allowedTools: [] };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--prompt') args.prompt = argv[++i] ?? '';
		else if (argv[i] === '--model') args.model = argv[++i] ?? args.model;
		else if (argv[i] === '--effort') args.effort = argv[++i] ?? args.effort;
		else if (argv[i] === '--resume') args.resume = argv[++i] ?? '';
		else if (argv[i] === '--allowed-tools') args.allowedTools = (argv[++i] ?? '').split(',').filter(Boolean);
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

const TOOL_NAME = 'Bash';
const TOOL_INPUT = { command: 'git commit -am "wip"' };

// Simulates Claude attempting a tool call: emits the `assistant` message with
// the tool_use block, then a `user` message with the tool_result — shapes
// confirmed for real from an earlier capture (see plan.md), unlike the rest
// of this scenario which is a documented hypothesis.
async function attemptTool (sessionId, messageId, model, allowedTools) {
	let toolId = `toolu_mock_${randomUUID()}`;
	await emit({
		type: 'assistant',
		session_id: sessionId,
		message: {
			id: messageId,
			type: 'message',
			role: 'assistant',
			model,
			content: [{ type: 'tool_use', id: toolId, name: TOOL_NAME, input: TOOL_INPUT }],
		},
	});

	await wait(randomDelay(100, 300));

	let allowed = allowedTools.includes(TOOL_NAME);
	await emit({
		type: 'user',
		session_id: sessionId,
		message: {
			role: 'user',
			content: [{
				type: 'tool_result',
				tool_use_id: toolId,
				content: allowed
					? 'wip\n 1 file changed, 1 insertion(+)'
					: `Claude requested permissions to use ${TOOL_NAME}, but you haven't granted it yet.`,
				is_error: !allowed,
			}],
		},
	});

	return allowed
		? ' (Commande Bash exécutée avec succès.)'
		: ' (Permission requise pour Bash, en attente de ton autorisation.)';
}

async function main () {
	let { prompt, model, effort, resume, allowedTools } = parseArgs(process.argv.slice(2));
	let sessionId = resume || randomUUID();
	let messageId = `msg_mock_${randomUUID()}`;
	let isResuming = Boolean(resume);

	await emit({
		type: 'system',
		subtype: 'init',
		session_id: sessionId,
		model,
		effort,
		permissionMode: 'default',
		cwd: process.cwd(),
	});

	// No fake session-title stream event here: confirmed for real (see plan.md)
	// that Claude Code *does* generate an automatic title ("ai-title") for every
	// session, including plain `-p` runs, but it's written asynchronously to the
	// session's own file on disk (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl),
	// never sent over stdout. Real title support belongs with session/history
	// persistence, since it reads the same file — not simulated here.

	await wait(randomDelay(200, 500));

	let interactionNote = '';
	if (isResuming) {
		// A resumed run means the frontend just granted a permission it saw
		// denied earlier: retry the same tool now that it's allowed.
		interactionNote = await attemptTool(sessionId, messageId, model, allowedTools);
	} else {
		let roll = Math.random();
		if (roll < 0.3) {
			interactionNote = await attemptTool(sessionId, messageId, model, allowedTools);
		} else if (roll < 0.6) {
			// Hypothetical event, not confirmed on the real `claude` CLI yet (its
			// interactive control protocol wasn't captured for real, see plan.md).
			// A user question is open: predefined options are offered, but a
			// free-text answer is still valid — unlike a permission request.
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

	// Confirmed for real with --prompt-suggestions=true on an actionable prompt
	// (see plan.md): the field is "suggestion", fires after "result", no id/
	// response expected (fire-and-forget, unlike user_question). Emitted here
	// roughly half the time, to exercise prefilling the prompt field on the
	// frontend without suggesting one on every single turn.
	if (Math.random() < 0.5) {
		await wait(randomDelay(100, 300));
		await emit({
			type: 'prompt_suggestion',
			session_id: sessionId,
			suggestion: 'commit ça',
		});
	}

	// Listening on stdin (for user_question responses) keeps the process alive
	// otherwise, since it's an open handle from Node's perspective.
	stdinInterface.close();
}

main();
