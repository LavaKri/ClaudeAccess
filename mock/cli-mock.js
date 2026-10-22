// Standalone mock of a long-lived
//   claude -p --input-format stream-json --output-format stream-json --verbose
//           --permission-prompt-tool stdio --replay-user-messages
// process. Reads one JSON object per line on stdin, emits one per line on
// stdout, shaped after real captures against claude 2.1.268 (see plan.md), so
// the server/frontend can be developed without spending real usage. Run via
// `npm run start:mock` / `dev:mock` instead of the real `claude` binary — see
// server.js's --mock handling.
//
// Behaviors reproduced from the real CLI:
// - The process stays alive between turns until stdin is closed. Closing
//   stdin while idle exits at once; closing it mid-turn abandons the turn
//   (no `result`) and exits.
// - `system`/`init` is emitted at the start of *every* turn, not just once.
// - A user message sent while a turn is running is queued, then injected
//   into the running turn at the next tool-result boundary (no extra
//   `result`). With --replay-user-messages, each user message is echoed back
//   with `isReplay: true` at the moment it is actually consumed.
// - `control_request`s: initialize, interrupt, set_model,
//   set_permission_mode, apply_flag_settings, set_max_thinking_tokens; any
//   other subtype gets an error response.
// - With --permission-prompt-tool stdio, a tool needing approval sends a
//   `control_request` `can_use_tool` and waits for the matching
//   `control_response`; an interrupt while it's pending emits
//   `control_cancel_request` for it. Without that flag, the tool is denied
//   outright (old one-shot behavior). AskUserQuestion only exists with it.
// - "/clear" as a user message starts a new conversation in the same
//   process: `conversation_reset`, then an `init` carrying the new session
//   id (not the reset's new_conversation_id), then an empty `result`.
//
// Scenario picked from keywords in the prompt (case-insensitive):
// - "question"        → AskUserQuestion (falls back to plain text without
//                       --permission-prompt-tool stdio)
// - "long" / "sleep"  → slow Bash tool (~10 s, runs without approval), to
//                       try mid-turn messages and interrupt
// - "write" / "écri"  → Write tool (approval-gated unless acceptEdits)
// - "tool" / "outil"  → Bash tool (approval-gated)
// - "crash"           → the process exits mid-turn (code 1), no `result`
// - "fail" / "échec"  → failed turn (`result` with is_error), as when the
//                       CLI needs to log in again
// - anything else     → plain text answer

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const CANNED_RESPONSES = [
	"Bonjour ! Ceci est une réponse simulée du mock de claude CLI, générée localement sans consommer d'usage réel.",
	"Voici une deuxième réponse possible, juste pour varier un peu le contenu affiché pendant les tests.",
	"Réponse simulée numéro trois : le vrai claude n'est pas appelé, rien n'est consommé.",
];

const MODEL_IDS = { haiku: 'claude-haiku-4-5-20251001', sonnet: 'claude-sonnet-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

function parseArgs (argv) {
	let args = {
		model: 'sonnet', effort: 'medium', permissionMode: 'default', resume: '', sessionId: '',
		allowedTools: [], stdioPermissions: false, replayUserMessages: false, partialMessages: false,
	};
	for (let i = 0; i < argv.length; i++) {
		let arg = argv[i];
		if (arg === '--model') args.model = argv[++i] ?? args.model;
		else if (arg === '--effort') args.effort = argv[++i] ?? args.effort;
		else if (arg === '--permission-mode') args.permissionMode = argv[++i] ?? args.permissionMode;
		else if (arg === '--resume' || arg === '-r') args.resume = argv[++i] ?? '';
		else if (arg === '--session-id') args.sessionId = argv[++i] ?? '';
		else if (arg === '--allowed-tools' || arg === '--allowedTools') args.allowedTools = (argv[++i] ?? '').split(',').filter(Boolean);
		else if (arg === '--permission-prompt-tool') args.stdioPermissions = argv[++i] === 'stdio';
		else if (arg === '--replay-user-messages') args.replayUserMessages = true;
		else if (arg === '--include-partial-messages') args.partialMessages = true;
		// -p, --input-format/--output-format/--verbose and anything else:
		// accepted, ignored — this mock only speaks stream-json both ways.
	}
	return args;
}

const options = parseArgs(process.argv.slice(2));

// Mutable process-wide state, mirroring what the real CLI keeps across turns.
let state = {
	sessionId: options.resume || options.sessionId || randomUUID(),
	model: options.model,
	permissionMode: options.permissionMode,
	// Session-scoped allow rules, as added by "always allow" answers
	// (updatedPermissions with addRules). Tool names only: this mock doesn't
	// try to match rule contents like "mkdir foo *".
	allowedTools: new Set(options.allowedTools),
	totalCostUsd: 0,
	resultIndex: 0,
	turn: null,
	queue: [],
	pendingPermissions: new Map(),
	stdinClosed: false,
};

// Returns a promise resolved once the write is flushed. On Windows, a pipe's
// stdout write is asynchronous and the process can exit before it completes,
// silently dropping whichever line was written last — awaiting this avoids that.
function emit (obj) {
	return new Promise(resolve => process.stdout.write(JSON.stringify(obj) + '\n', resolve));
}

function randomDelay (min = 40, max = 160) {
	return Math.floor(min + Math.random() * (max - min));
}

class Aborted extends Error {}

// Sleeps, but rejects early with Aborted if the turn gets interrupted (or
// stdin closed) in the meantime, so every step of a turn can bail out.
function wait (turn, ms) {
	return new Promise((resolve, reject) => {
		if (turn.aborted) return reject(new Aborted());
		let timer = setTimeout(() => { turn.onAbort.delete(cancel); resolve(); }, ms);
		let cancel = () => { clearTimeout(timer); reject(new Aborted()); };
		turn.onAbort.add(cancel);
	});
}

function modelId () {
	return MODEL_IDS[state.model] || state.model;
}

function textOf (message) {
	let content = message?.message?.content;
	if (typeof content === 'string') return content;
	return (content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function pickScenario (prompt) {
	let p = prompt.toLowerCase();
	if (p.includes('question') && options.stdioPermissions) return 'ask';
	if (p.includes('long') || p.includes('sleep')) return 'slow';
	if (p.includes('write') || p.includes('écri')) return 'write';
	if (p.includes('tool') || p.includes('outil')) return 'bash';
	if (p.includes('crash')) return 'crash';
	if (p.includes('fail') || p.includes('échec')) return 'fail';
	return 'text';
}

function systemInit () {
	return emit({
		type: 'system',
		subtype: 'init',
		cwd: process.cwd(),
		session_id: state.sessionId,
		tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write', ...(options.stdioPermissions ? ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'] : [])],
		model: modelId(),
		permissionMode: state.permissionMode,
		claude_code_version: 'mock',
		uuid: randomUUID(),
	});
}

function replay (message) {
	if (!options.replayUserMessages) return;
	return emit({
		type: 'user',
		message: { role: 'user', content: message.message.content },
		session_id: state.sessionId,
		parent_tool_use_id: null,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
		isReplay: true,
	});
}

function assistantMessage (turn, content) {
	return emit({
		type: 'assistant',
		message: { model: modelId(), id: turn.messageId, type: 'message', role: 'assistant', content },
		parent_tool_use_id: null,
		session_id: state.sessionId,
		uuid: randomUUID(),
	});
}

function toolResult (toolUseId, content, isError) {
	return emit({
		type: 'user',
		message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
		parent_tool_use_id: null,
		session_id: state.sessionId,
		uuid: randomUUID(),
		timestamp: new Date().toISOString(),
	});
}

// Streams a text answer: optional partial `stream_event`s (only with
// --include-partial-messages, like the real CLI), then the full `assistant`
// message. Returns the text.
async function streamText (turn, text) {
	turn.messageId = `msg_mock_${randomUUID()}`;
	let streamEvent = event => options.partialMessages && emit({ type: 'stream_event', event, session_id: state.sessionId, parent_tool_use_id: null, uuid: randomUUID() });
	await streamEvent({ type: 'message_start', message: { id: turn.messageId, type: 'message', role: 'assistant', model: modelId(), content: [] } });
	await streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
	let words = text.split(' ');
	for (let i = 0; i < words.length; i++) {
		await streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i === 0 ? '' : ' ') + words[i] } });
		await wait(turn, randomDelay());
	}
	await streamEvent({ type: 'content_block_stop', index: 0 });
	await streamEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
	await streamEvent({ type: 'message_stop' });
	await assistantMessage(turn, [{ type: 'text', text }]);
	return text;
}

// Messages queued while the turn was running get consumed here, at the next
// tool-result boundary — the point where the real CLI injects them.
async function drainQueueIntoTurn (turn) {
	while (state.queue.length) {
		let message = state.queue.shift();
		turn.injected.push(textOf(message));
		await replay(message);
	}
}

// Real suggestion shapes, as captured for a Bash command and a Write call.
function permissionSuggestions (toolName, input) {
	if (toolName === 'Write') return [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }];
	return [
		{ type: 'addRules', rules: [{ toolName, ruleContent: `${input.command.split(' ')[0]} *` }], behavior: 'allow', destination: 'localSettings' },
		{ type: 'addDirectories', directories: [process.cwd()], destination: 'session' },
		{ type: 'setMode', mode: 'acceptEdits', destination: 'session' },
	];
}

function needsApproval (toolName) {
	if (toolName === 'AskUserQuestion') return true;
	if (state.permissionMode === 'bypassPermissions') return false;
	if (state.allowedTools.has(toolName)) return false;
	if (toolName === 'Write' && state.permissionMode === 'acceptEdits') return false;
	return true;
}

async function setPermissionMode (mode) {
	state.permissionMode = mode;
	await emit({ type: 'system', subtype: 'status', status: null, permissionMode: mode, uuid: randomUUID(), session_id: state.sessionId });
}

// Sends `can_use_tool` and waits for the host's `control_response`. Resolves
// to the host's decision ({ behavior: 'allow' | 'deny', ... }); rejects with
// Aborted if the turn is interrupted first, after telling the host to drop
// the request it may be showing (`control_cancel_request`).
function askPermission (turn, toolName, input, toolUseId) {
	let requestId = randomUUID();
	let request = { subtype: 'can_use_tool', tool_name: toolName, display_name: toolName, input, tool_use_id: toolUseId };
	if (toolName === 'AskUserQuestion') request.requires_user_interaction = true;
	else {
		request.description = input.description || input.file_path || toolName;
		request.permission_suggestions = permissionSuggestions(toolName, input);
	}
	return new Promise((resolve, reject) => {
		let cancel = () => {
			state.pendingPermissions.delete(requestId);
			emit({ type: 'control_cancel_request', request_id: requestId }).then(() => reject(new Aborted()));
		};
		if (turn.aborted) return reject(new Aborted());
		turn.onAbort.add(cancel);
		state.pendingPermissions.set(requestId, decision => {
			turn.onAbort.delete(cancel);
			state.pendingPermissions.delete(requestId);
			resolve(decision);
		});
		emit({ type: 'control_request', request_id: requestId, request });
	});
}

// One tool call: tool_use, approval if needed, then tool_result. Returns a
// short note on what happened, folded into the final text answer.
// `harmless` stands for the real CLI's own classification of commands it
// runs without asking (e.g. `sleep`, `echo`, observed never prompting).
async function runTool (turn, toolName, input, output, { runMs = 300, harmless = false } = {}) {
	let toolUseId = `toolu_mock_${randomUUID()}`;
	turn.toolUseId = toolUseId;
	turn.messageId = `msg_mock_${randomUUID()}`;
	await assistantMessage(turn, [{ type: 'tool_use', id: toolUseId, name: toolName, input }]);
	await wait(turn, randomDelay(100, 300));

	if (!harmless && needsApproval(toolName)) {
		if (!options.stdioPermissions) {
			// Old one-shot behavior, kept for runs without --permission-prompt-tool.
			turn.denials.push({ tool_name: toolName, tool_use_id: toolUseId, tool_input: input });
			turn.toolUseId = null;
			await toolResult(toolUseId, `Claude requested permissions to use ${toolName}, but you haven't granted it yet.`, true);
			await drainQueueIntoTurn(turn);
			return ` (Permission refusée pour ${toolName}.)`;
		}
		let decision = await askPermission(turn, toolName, input, toolUseId);
		if (decision.behavior !== 'allow') {
			turn.denials.push({ tool_name: toolName, tool_use_id: toolUseId, tool_input: input });
			turn.toolUseId = null;
			await toolResult(toolUseId, decision.message || 'Permission denied.', true);
			await drainQueueIntoTurn(turn);
			return ` (${toolName} refusé : « ${decision.message || ''} ».)`;
		}
		input = decision.updatedInput || input;
		for (let update of decision.updatedPermissions || []) {
			if (update.type === 'addRules') for (let rule of update.rules || []) state.allowedTools.add(rule.toolName);
			else if (update.type === 'setMode') await setPermissionMode(update.mode);
		}
	}

	if (toolName === 'AskUserQuestion') {
		let answers = input.answers || {};
		let summary = Object.entries(answers).map(([question, answer]) => `"${question}"="${answer}"`).join(', ');
		turn.toolUseId = null;
		await toolResult(toolUseId, `Your questions have been answered: ${summary}. You can now continue with these answers in mind.`, false);
		await drainQueueIntoTurn(turn);
		return ` Tu as répondu : ${Object.values(answers).join(', ') || '(rien)'}.`;
	}

	if (toolName === 'Bash') {
		let taskId = `b${randomUUID().slice(0, 8)}`;
		await emit({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: input.description, is_backgrounded: false, task_type: 'local_bash', uuid: randomUUID(), session_id: state.sessionId });
		await wait(turn, runMs);
		await emit({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status: 'completed', output_file: '', summary: input.description, uuid: randomUUID(), session_id: state.sessionId });
	} else {
		await wait(turn, runMs);
	}
	turn.toolUseId = null;
	await toolResult(toolUseId, output, false);
	await drainQueueIntoTurn(turn);
	return ` (${toolName} exécuté avec succès.)`;
}

async function emitResult (turn, fields) {
	await emit({
		type: 'result',
		subtype: 'success',
		is_error: false,
		num_turns: turn.numTurns,
		result: '',
		stop_reason: 'end_turn',
		terminal_reason: 'completed',
		session_id: state.sessionId,
		total_cost_usd: state.totalCostUsd,
		usage: { input_tokens: turn.prompt.length, output_tokens: 0 },
		permission_denials: turn.denials,
		queued_turn_count: state.queue.length,
		result_index: state.resultIndex++,
		uuid: randomUUID(),
		...fields,
	});
}

async function runTurn (message) {
	let prompt = textOf(message);
	let turn = { prompt, messageId: '', toolUseId: null, aborted: false, onAbort: new Set(), injected: [], denials: [], numTurns: 1 };
	state.turn = turn;

	if (prompt.trim() === '/clear') {
		// Two distinct ids, like the real CLI: new_conversation_id matches no
		// session file; the actual new session id only comes with `init`.
		await emit({ type: 'conversation_reset', new_conversation_id: randomUUID(), uuid: randomUUID(), session_id: state.sessionId });
		state.sessionId = randomUUID();
		await systemInit();
		await emitResult(turn, { num_turns: 0, stop_reason: null, terminal_reason: undefined });
		state.turn = null;
		return;
	}

	try {
		await systemInit();
		await wait(turn, randomDelay(200, 500));
		await replay(message);

		let note = '';
		let scenario = pickScenario(prompt);
		if (scenario === 'crash') process.exit(1);
		if (scenario === 'fail') {
			// Shape not confirmed against the real CLI (not reproduced yet): a
			// failed turn as when the CLI needs to log in again.
			let text = 'Not logged in · Please run /login';
			await streamText(turn, text);
			await emitResult(turn, { is_error: true, result: text });
			return;
		}
		if (scenario === 'ask') {
			turn.numTurns++;
			note = await runTool(turn, 'AskUserQuestion', {
				questions: [{
					question: 'Tu préfères le thé ou le café ?',
					header: 'Boisson',
					multiSelect: false,
					options: [
						{ label: 'Thé', description: 'Infusion de feuilles de thé' },
						{ label: 'Café', description: 'Boisson à base de grains de café' },
					],
				}],
			}, '');
		} else if (scenario === 'slow') {
			turn.numTurns++;
			note = await runTool(turn, 'Bash', { command: 'sleep 10 && echo done', description: 'Attendre 10 secondes' }, 'done', { runMs: 10000, harmless: true });
		} else if (scenario === 'write') {
			turn.numTurns++;
			note = await runTool(turn, 'Write', { file_path: `${process.cwd()}\\mock.txt`, content: 'mock' }, `File created successfully at: ${process.cwd()}\\mock.txt`);
		} else if (scenario === 'bash') {
			turn.numTurns++;
			note = await runTool(turn, 'Bash', { command: 'mkdir build', description: 'Créer le dossier build' }, '(Bash completed with no output)');
		}

		let text = CANNED_RESPONSES[Math.floor(Math.random() * CANNED_RESPONSES.length)] + note;
		if (turn.injected.length) text += ` Message reçu en cours de route : « ${turn.injected.join(' » / « ')} ».`;
		await wait(turn, randomDelay(200, 500));
		await streamText(turn, text);

		state.totalCostUsd += 0.01;
		await emitResult(turn, { result: text, usage: { input_tokens: prompt.length, output_tokens: text.length } });

		// Confirmed for real with --prompt-suggestions=true on an actionable
		// prompt (see plan.md): the field is "suggestion", fires after
		// "result", fire-and-forget. Emitted here roughly half the time.
		if (Math.random() < 0.5) {
			await emit({ type: 'prompt_suggestion', suggestion: 'commit ça', session_id: state.sessionId, uuid: randomUUID() });
		}
	} catch (err) {
		if (!(err instanceof Aborted)) throw err;
		if (!state.stdinClosed) {
			// Shapes captured from a real interrupt during a tool call.
			if (turn.toolUseId) await toolResult(turn.toolUseId, "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.", true);
			await emit({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] }, parent_tool_use_id: null, session_id: state.sessionId, uuid: randomUUID(), timestamp: new Date().toISOString() });
			await emitResult(turn, { subtype: 'error_during_execution', is_error: true, stop_reason: 'tool_use', terminal_reason: 'aborted_tools', result: undefined });
		}
	} finally {
		state.turn = null;
	}
}

// Runs queued messages one turn at a time. Messages queued during a turn but
// not consumed by it (no tool boundary reached) start the next turn.
async function pump () {
	if (state.turn) return;
	while (state.queue.length && !state.stdinClosed) {
		await runTurn(state.queue.shift());
	}
	if (state.stdinClosed) process.exit(0);
}

function abortTurn () {
	let turn = state.turn;
	if (!turn || turn.aborted) return;
	turn.aborted = true;
	for (let cancel of turn.onAbort) cancel();
	turn.onAbort.clear();
}

async function handleControlRequest ({ request_id: requestId, request }) {
	let success = response => emit({ type: 'control_response', response: { subtype: 'success', request_id: requestId, ...(response ? { response } : {}) } });
	switch (request?.subtype) {
		case 'initialize':
			await success({
				commands: [],
				agents: [],
				models: Object.keys(MODEL_IDS).map(value => ({ value, displayName: value })),
				pid: process.pid,
				current_permission_mode: state.permissionMode,
			});
			break;
		case 'interrupt':
			await success({ still_queued: [] });
			abortTurn();
			break;
		case 'set_model':
			state.model = request.model || options.model;
			await emit({ type: 'user', message: { role: 'user', content: `<local-command-stdout>Set model to \`${state.model} (${modelId()})\`</local-command-stdout>` }, session_id: state.sessionId, parent_tool_use_id: null, uuid: randomUUID(), timestamp: new Date().toISOString(), isReplay: true });
			await success();
			break;
		case 'set_permission_mode':
			await success({ mode: request.mode });
			await setPermissionMode(request.mode);
			break;
		case 'apply_flag_settings':
		case 'set_max_thinking_tokens':
			await success();
			break;
		default:
			await emit({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported control request subtype: ${request?.subtype}` } });
	}
}

function handleLine (line) {
	if (!line.trim()) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		process.stderr.write(`Error parsing streaming input line: ${line}\n`);
		return;
	}
	if (message.type === 'user') {
		state.queue.push(message);
		pump();
	} else if (message.type === 'control_request') {
		handleControlRequest(message);
	} else if (message.type === 'control_response') {
		let resolve = state.pendingPermissions.get(message.response?.request_id);
		if (resolve) resolve(message.response.response || {});
	}
}

let lines = createInterface({ input: process.stdin });
lines.on('line', handleLine);
lines.on('close', () => {
	state.stdinClosed = true;
	// Mid-turn: abandon it without a result, like the real CLI; idle: exit now.
	if (state.turn) abortTurn();
	else process.exit(0);
});
