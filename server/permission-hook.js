// Method B of doc/claude-p-usage.md: each run gets a PermissionRequest hook
// of type "http" (through --settings) pointing at this server. The CLI POSTs
// the request and waits; the request is forwarded to the page, and the page's
// answer becomes the hook's response. Shapes checked against the real CLI
// (2.1.286) on 2026-10-17: allow, allow + updatedPermissions (destination
// "session"), deny + message (read by the model), deny + interrupt. No answer
// before the hook's timeout: the CLI denies as for any `-p` denial.

import { randomUUID } from 'node:crypto';

// runId -> { send }, one per CLI process started with the hook. The runId is
// random and unguessable: the server has no authentication, and the id in the
// URL is what ties a hook call to the page that started the run.
const runs = new Map();
// requestId -> { runId, res }, the hook calls still waiting for an answer.
const pending = new Map();

export function registerRun (send) {
	let runId = randomUUID();
	runs.set(runId, { send });
	return runId;
}

// The --settings value of a run. 0.0.0.0 / :: listen on every interface but
// can't be connected to as such: the CLI runs on this machine, so loopback.
export function hookSettings (runId, host, port, timeoutMinutes) {
	let connectHost = ['0.0.0.0', '::', ''].includes(host) ? '127.0.0.1' : host;
	let url = `http://${connectHost.includes(':') ? `[${connectHost}]` : connectHost}:${port}/hook/permission/${runId}`;
	return JSON.stringify({
		hooks: { PermissionRequest: [{ hooks: [{ type: 'http', url, timeout: timeoutMinutes * 60 }] }] },
	});
}

function reply (res, decision) {
	if (res.writableEnded) return;
	res.json({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

// Ends a run: whatever it still waits for is denied, so the CLI never hangs on
// a page that's gone. `interrupt` also stops the CLI's turn (Abort).
export function closeRun (runId, { interrupt = false } = {}) {
	if (!runId) return;
	runs.delete(runId);
	for (let [requestId, request] of pending) {
		if (request.runId !== runId) continue;
		pending.delete(requestId);
		reply(request.res, { behavior: 'deny', message: 'The user stopped the run.', ...(interrupt && { interrupt: true }) });
	}
}

// POST /hook/permission/:runId. An unknown run gets an empty answer, which the
// CLI treats as no decision, hence a denial.
export function handleHookRequest (req, res) {
	let run = runs.get(req.params.runId);
	if (!run) {
		res.json({});
		return;
	}
	let requestId = randomUUID();
	pending.set(requestId, { runId: req.params.runId, res });
	// Closed before any answer: the CLI gave up (its timeout) or went away.
	res.on('close', () => {
		if (!pending.has(requestId)) return;
		pending.delete(requestId);
		run.send({ type: 'permission_request_expired', requestId });
	});
	let body = req.body ?? {};
	run.send({
		type: 'permission_request',
		requestId,
		tool_name: body.tool_name,
		tool_input: body.tool_input,
		permission_suggestions: body.permission_suggestions,
	});
}

// "Bash(npm *)" -> { toolName: 'Bash', ruleContent: 'npm *' }; a bare tool name
// has no ruleContent.
function toRuleValue (rule) {
	let match = rule.match(/^([^(]+)\((.*)\)$/s);
	return match ? { toolName: match[1], ruleContent: match[2] } : { toolName: rule };
}

// The page's answer: { requestId, allow, rules?, message?, interrupt? }. Only
// the run that sent the request (same page) may answer it.
export function answerRequest (runId, answer) {
	let request = pending.get(answer?.requestId);
	if (!request || request.runId !== runId) return false;
	pending.delete(answer.requestId);
	let rules = (Array.isArray(answer.rules) ? answer.rules : []).filter(rule => typeof rule === 'string' && rule);
	if (answer.allow) {
		reply(request.res, {
			behavior: 'allow',
			...(rules.length && {
				updatedPermissions: [{ type: 'addRules', rules: rules.map(toRuleValue), behavior: 'allow', destination: 'session' }],
			}),
		});
	} else {
		reply(request.res, {
			behavior: 'deny',
			message: typeof answer.message === 'string' && answer.message.trim() ? answer.message.trim() : 'The user denied this action.',
			...(answer.interrupt && { interrupt: true }),
		});
	}
	return true;
}
