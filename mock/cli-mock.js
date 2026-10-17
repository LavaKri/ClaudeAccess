// Standalone mock of `claude -p <prompt> --output-format stream-json --verbose`.
// Emits one JSON object per line on stdout, shaped after a real captured stream
// (see doc/plan.md step 1), so the server/frontend can be developed without spending
// real usage. Run via `npm run start:mock` / `dev:mock` instead of the real
// `claude` binary — see server.js's --mock handling.
//
// Permission handling follows the pattern confirmed by reading claude-code-webui
// (see doc/plan.md): there is no live pause/resume within a single run. An
// unauthorized tool simply comes back as a `tool_result` with `is_error: true`;
// the caller is expected to detect that, then start a *new* run with `--resume`
// and the tool added to `--allowed-tools`.

import { randomUUID } from 'node:crypto';

const CANNED_RESPONSES = [
	"Bonjour ! Ceci est une réponse simulée du mock de claude CLI, générée localement sans consommer d'usage réel.",
	"Voici une deuxième réponse possible, juste pour varier un peu le contenu affiché pendant les tests.",
	"Réponse simulée numéro trois : le vrai claude sera branché plus tard, une fois le protocole stabilisé.",
];

function parseArgs (argv) {
	let args = { prompt: '', model: 'sonnet', effort: 'medium', permissionMode: 'default', resume: '', allowedTools: [] };
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		// Real `claude` takes the prompt as a plain positional argument — the
		// server always places it right after -p (see server.js), so that's
		// the one case handled here rather than matching any bare token.
		if ((arg === '-p' || arg === '--print') && argv[i + 1] && !argv[i + 1].startsWith('--')) args.prompt = argv[++i];
		else if (arg === '--model') args.model = argv[++i] ?? args.model;
		else if (arg === '--effort') args.effort = argv[++i] ?? args.effort;
		else if (arg === '--permission-mode') args.permissionMode = argv[++i] ?? args.permissionMode;
		else if (arg === '--resume') args.resume = argv[++i] ?? '';
		else if (arg === '--fork-session') args.fork = true;
		// Variadic, like the real option: every following argument up to the next
		// option is a rule (the server passes one rule per argument).
		else if (arg === '--allowed-tools' || arg === '--allowedTools') {
			while (argv[i + 1] && !argv[i + 1].startsWith('--')) args.allowedTools.push(...argv[++i].split(',').filter(Boolean));
		}
		// --output-format/--verbose and anything else: accepted, ignored —
		// this mock always emits the same stream-json shape regardless.
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
// Wording of a real Bash denial ("This command requires approval", seen in a real
// session). Write and Edit say "Claude requested permissions to write to <path>,
// but you haven't granted it yet." instead; don't mode says "Permission to use X
// has been denied because Claude Code is running in don't ask mode…".
const DENIAL_TEXT = 'This command requires approval';

// Simulates Claude attempting a tool call: emits the `assistant` message with
// the tool_use block, then a `user` message with the tool_result — shapes
// confirmed for real from an earlier capture (see doc/plan.md), unlike the rest
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

	// The bare tool name, the exact command, or a "Bash(<first word> *)" rule
	// that matches it — the shapes ClaudeAccess sends.
	let firstWord = TOOL_INPUT.command.split(/\s+/)[0];
	let allowed = allowedTools.some(rule => rule === TOOL_NAME
		|| rule === `${TOOL_NAME}(${TOOL_INPUT.command})`
		|| rule === `${TOOL_NAME}(${firstWord} *)`);
	if (!allowed) {
		// The real CLI announces every denial with a dedicated system message right
		// before the (error) tool_result, then lists it in the result's
		// permission_denials — both confirmed on a real run (see doc/plan.md).
		await emit({
			type: 'system',
			subtype: 'permission_denied',
			tool_name: TOOL_NAME,
			tool_use_id: toolId,
			message: DENIAL_TEXT,
			session_id: sessionId,
		});
	}
	await emit({
		type: 'user',
		session_id: sessionId,
		message: {
			role: 'user',
			content: [{
				type: 'tool_result',
				tool_use_id: toolId,
				content: allowed ? 'wip\n 1 file changed, 1 insertion(+)' : DENIAL_TEXT,
				is_error: !allowed,
			}],
		},
	});

	return {
		note: allowed
			? ' (Commande Bash exécutée avec succès.)'
			: ' (Permission requise pour Bash, en attente de ton autorisation.)',
		denial: allowed ? null : { tool_name: TOOL_NAME, tool_use_id: toolId, tool_input: TOOL_INPUT },
	};
}

// Emits what the real CLI streams while the model thinks: a few estimated
// thinking-token counters, then an assistant message holding a (possibly empty)
// thinking block. Confirmed on a real run.
async function emitThinking (sessionId, model) {
	for (let tokens = 50; tokens <= 100; tokens += 50) {
		await emit({
			type: 'system',
			subtype: 'thinking_tokens',
			estimated_tokens: tokens,
			estimated_tokens_delta: 50,
			session_id: sessionId,
		});
		await wait(randomDelay(30, 80));
	}
	await emit({
		type: 'assistant',
		session_id: sessionId,
		message: {
			id: `msg_mock_think_${randomUUID()}`,
			type: 'message',
			role: 'assistant',
			model,
			content: [{ type: 'thinking', thinking: '' }],
		},
	});
}

async function main () {
	let { prompt, model, effort, resume, fork, allowedTools } = parseArgs(process.argv.slice(2));
	// Like the real CLI, --fork-session with --resume continues under a new id.
	let sessionId = (resume && !fork) ? resume : randomUUID();
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

	// No fake session-title stream event here: confirmed for real (see doc/plan.md)
	// that Claude Code *does* generate an automatic title ("ai-title") for every
	// session, including plain `-p` runs, but it's written asynchronously to the
	// session's own file on disk (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl),
	// never sent over stdout. Real title support belongs with session/history
	// persistence, since it reads the same file — not simulated here.

	await wait(randomDelay(200, 500));

	await emitThinking(sessionId, model);

	let interactionNote = '';
	let denials = [];
	let attempt = null;
	if (isResuming) {
		// A resumed run means the frontend just granted a permission it saw
		// denied earlier: retry the same tool now that it's allowed.
		attempt = await attemptTool(sessionId, messageId, model, allowedTools);
	} else if (Math.random() < 0.3) {
		attempt = await attemptTool(sessionId, messageId, model, allowedTools);
	}
	if (attempt) {
		interactionNote = attempt.note;
		if (attempt.denial) denials.push(attempt.denial);
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

	// Same shape as the real CLI's (seen on 2026-10-17), with made-up figures.
	let now = Math.floor(Date.now() / 1000);
	await emit({
		type: 'rate_limit_event',
		session_id: sessionId,
		rate_limit_info: {
			status: 'allowed_warning', resetsAt: now + 3 * 86400, rateLimitType: 'seven_day',
			utilization: 0.8, isUsingOverage: false, surpassedThreshold: 0.75,
			unifiedWindows: {
				five_hour: { utilization: Math.round(Math.random() * 100) / 100, resetsAt: now + 2 * 3600 },
				seven_day: { utilization: 0.8, resetsAt: now + 3 * 86400 },
			},
		},
	});

	await emit({
		type: 'result',
		subtype: 'success',
		session_id: sessionId,
		result: fullText,
		permission_denials: denials,
		usage: { input_tokens: prompt.length, output_tokens: fullText.length },
	});

	// Confirmed for real with --prompt-suggestions=true on an actionable prompt
	// (see doc/plan.md): the field is "suggestion", fires after "result", no id/
	// response expected — fire-and-forget. Emitted here roughly half the time,
	// to exercise prefilling the prompt field on the frontend without
	// suggesting one on every single turn.
	if (Math.random() < 0.5) {
		await wait(randomDelay(100, 300));
		await emit({
			type: 'prompt_suggestion',
			session_id: sessionId,
			suggestion: 'commit ça',
		});
	}
}

main();
