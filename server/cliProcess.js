// The one long-lived `claude -p --input-format stream-json` process shared by
// the whole server (one conversation at a time, whichever browser tab drives
// it). Kept alive between prompts and across WebSocket disconnections, so the
// user can talk to Claude while it works, answer permission requests live,
// and close/reopen the page without losing a running turn. See plan.md for
// the protocol details this relies on, all confirmed against the real CLI.
//
// Lifecycle:
// - Started on the first prompt only (never preloaded), in the prompt's cwd,
//   resuming its session or starting a new one with an id chosen here.
// - Model, effort and permission mode are changed live, never by restarting.
// - Restarted when a prompt targets another cwd or another existing session.
//   If Claude is busy at that point, the caller gets a confirmation request
//   back instead, and nothing is sent until the prompt is re-sent confirmed.
// - A new session in the same cwd reuses the process ("/clear").
// - Stopped after a configurable idle time — also while a permission request
//   or question is pending, but only once no client is connected anymore.

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathKey } from './history.js';

// How long a graceful stop (closing stdin) may take before the process tree
// is killed outright. Measured: ~6 s when stdin closes mid-turn.
const STOP_GRACE_MS = 10000;
// How long an interrupt may go unanswered (no `result`) before the process is
// presumed hung and killed — the escape hatch for a zombie process.
const INTERRUPT_GRACE_MS = 15000;

// Kills the whole process tree. On Windows, child.kill() only ends claude.exe
// itself and leaves commands it was running (bash, builds...) orphaned —
// confirmed for real (see plan.md); taskkill /T takes the whole tree down.
function forceKill (child) {
	if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
	else child.kill('SIGKILL');
}

function hasExited (child) {
	return child.exitCode !== null || child.signalCode !== null;
}

export class CliProcess {
	// resolveCommand: async () => [command, ...args] to launch claude with.
	// getIdleTimeoutMs: async () => idle delay before stopping the process.
	// broadcast: (payload) => void, sends an object or a raw JSON line to
	// every connected client.
	constructor ({ resolveCommand, getIdleTimeoutMs, broadcast }) {
		this.resolveCommand = resolveCommand;
		this.getIdleTimeoutMs = getIdleTimeoutMs;
		this.broadcast = broadcast;
		this.child = null;
		this.cwd = null;
		// null while a "/clear" is in flight: the new id is only known once
		// the CLI's next `init` reports it.
		this.sessionId = null;
		this.options = { model: null, effort: null, permissionMode: null };
		// Set from the moment a user message is written until the `result`
		// that leaves no message unanswered.
		this.busy = false;
		// User messages written but not yet consumed by Claude, counted with
		// the --replay-user-messages acknowledgments (the CLI's own
		// queued_turn_count was found unreliable: 0 while a message waited).
		this.unconsumed = 0;
		this.interruptRequested = false;
		// request_id -> raw `can_use_tool` line, re-sent to clients that
		// (re)connect while it's still unanswered.
		this.pendingPermissions = new Map();
		// request_ids of our own control requests, whose responses are
		// consumed here rather than forwarded.
		this.ownRequests = new Set();
		this.clientCount = 0;
		this.idleTimer = null;
		this.idleTimerToken = 0;
		this.idleTimerArming = false;
		this.interruptTimer = null;
		this.expectedExit = null;
		this.lastStatusJson = '';
	}

	get status () {
		if (!this.child) return 'stopped';
		if (this.pendingPermissions.size) return 'waiting';
		return this.busy ? 'working' : 'idle';
	}

	isBusy () {
		return this.status === 'working' || this.status === 'waiting';
	}

	snapshot (reason) {
		let running = Boolean(this.child);
		return {
			type: 'status',
			status: this.status,
			cwd: running ? this.cwd : null,
			sessionId: running ? this.sessionId : null,
			model: running ? this.options.model : null,
			effort: running ? this.options.effort : null,
			permissionMode: running ? this.options.permissionMode : null,
			...(reason ? { reason } : {}),
		};
	}

	pendingRequestLines () {
		return [...this.pendingPermissions.values()];
	}

	// Broadcasts the status only when something in it actually changed, so
	// clients can announce every message they get without repeats.
	emitStatus (reason) {
		let status = this.snapshot(reason);
		let json = JSON.stringify(status);
		if (json !== this.lastStatusJson || reason) {
			this.lastStatusJson = json;
			this.broadcast(status);
		}
		this.updateIdleTimer();
	}

	setClientCount (count) {
		this.clientCount = count;
		this.updateIdleTimer();
	}

	updateIdleTimer () {
		let shouldRun = this.status === 'idle' || (this.status === 'waiting' && this.clientCount === 0);
		if (!shouldRun) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
			this.idleTimerToken++;
			return;
		}
		if (this.idleTimer || this.idleTimerArming) return;
		// The delay comes from the (async) config, read again each time so a
		// change in the options applies from the next idle period on. The
		// token discards an arming made obsolete while the config was read.
		let token = ++this.idleTimerToken;
		this.idleTimerArming = true;
		this.getIdleTimeoutMs().then(delay => {
			this.idleTimerArming = false;
			// Conditions changed while the config was read: start over.
			if (token !== this.idleTimerToken) return this.updateIdleTimer();
			this.idleTimer = setTimeout(() => {
				this.idleTimer = null;
				this.stop('idle');
			}, delay);
		});
	}

	// Handles a prompt from a client. Returns { confirmRestart: reason } when
	// sending it would stop a busy process (reason: 'cwd' | 'session') and
	// the request didn't say it was confirmed — nothing is sent in that case.
	async prompt ({ prompt, cwd, sessionId, model, effort, permissionMode, confirmRestart }) {
		// Kept as the client spelled it (reported back in status messages,
		// which clients compare with their own); compared via pathKey().
		cwd = cwd || process.cwd();
		sessionId = sessionId || null;

		if (this.child) {
			let reason = null;
			if (pathKey(cwd) !== pathKey(this.cwd)) reason = 'cwd';
			else if (sessionId !== this.sessionId) reason = 'session';

			if (reason && this.isBusy() && !confirmRestart) return { confirmRestart: reason };
			if (reason === 'session' && !sessionId && !this.isBusy()) {
				// New session, same cwd, nothing running: no restart needed.
				this.applyOptions({ model, effort, permissionMode }, false);
				this.clearConversation();
			} else if (reason) {
				await this.stop('restart');
			} else {
				this.applyOptions({ model, effort, permissionMode }, false);
			}
		}

		if (!this.child) await this.start({ cwd, sessionId, model, effort, permissionMode });
		this.writeUserMessage(prompt);
		return {};
	}

	async start ({ cwd, sessionId, model, effort, permissionMode }) {
		let [command, ...baseArgs] = await this.resolveCommand();
		if (!command) throw new Error('No CLI command configured');

		this.options = { model: model || 'sonnet', effort: effort || 'low', permissionMode: permissionMode || 'default' };
		// A new session gets its id from us rather than from the CLI's first
		// `init`, so clients know it right away (an `init` only comes 4-6 s
		// later) and their next message can already refer to it.
		let newSessionId = sessionId ? null : randomUUID();
		let args = [
			...baseArgs,
			'-p',
			'--input-format', 'stream-json',
			'--output-format', 'stream-json',
			// stream-json output requires --verbose or the CLI refuses to start.
			'--verbose',
			// Permission requests (and AskUserQuestion) come through stdio as
			// `can_use_tool` control requests, answered live.
			'--permission-prompt-tool', 'stdio',
			// Echoes each user message when Claude actually consumes it.
			'--replay-user-messages',
			'--model', this.options.model,
			'--effort', this.options.effort,
			'--permission-mode', this.options.permissionMode,
			...(sessionId ? ['--resume', sessionId] : ['--session-id', newSessionId]),
		];

		let child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
		this.child = child;
		this.cwd = cwd;
		this.sessionId = sessionId || newSessionId;
		this.busy = false;
		this.unconsumed = 0;
		this.interruptRequested = false;

		createInterface({ input: child.stdout }).on('line', line => {
			if (child === this.child && line.trim()) this.handleLine(line);
		});
		child.stderr.on('data', chunk => {
			if (child === this.child) this.broadcast({ type: 'error', message: chunk.toString() });
		});
		// A write to a process that just died fails asynchronously (EPIPE);
		// its 'exit' handler below does the actual cleanup.
		child.stdin.on('error', () => {});
		child.on('error', err => {
			this.broadcast({ type: 'error', message: `Failed to start claude process: ${err.message}` });
			if (child === this.child) this.onExit(child, 'error');
		});
		child.on('exit', code => {
			if (child !== this.child) return;
			let expected = this.expectedExit?.child === child;
			if (!expected) this.broadcast({ type: 'error', message: `claude process exited unexpectedly (code ${code})` });
			this.onExit(child, expected ? this.expectedExit.reason : 'crash');
		});

		this.sendControl({ subtype: 'initialize' });
		// No status emitted yet: the caller writes the prompt right away,
		// which reports "working" — an "idle" in between would be noise.
	}

	onExit (child, reason) {
		if (child !== this.child) return;
		clearTimeout(this.interruptTimer);
		this.child = null;
		this.expectedExit = null;
		this.busy = false;
		this.unconsumed = 0;
		this.pendingPermissions.clear();
		this.ownRequests.clear();
		this.emitStatus(reason);
	}

	// Stops the process: closes stdin (a clean exit, which also ends whatever
	// commands it was running), then kills the whole tree if that takes too
	// long. reason ('idle' | 'restart' | 'shutdown') is passed on to clients.
	async stop (reason) {
		let child = this.child;
		if (!child) return;
		this.expectedExit = { child, reason };
		child.stdin.end();
		await new Promise(resolve => {
			if (hasExited(child)) return resolve();
			child.once('exit', resolve);
			setTimeout(() => {
				if (hasExited(child)) return;
				forceKill(child);
				// Last resort if even that never reports an exit: carry on.
				setTimeout(resolve, 3000);
			}, STOP_GRACE_MS);
		});
		// If the exit event never came, don't leave a dead process registered.
		this.onExit(child, reason);
	}

	write (payload) {
		this.child.stdin.write(JSON.stringify(payload) + '\n');
	}

	sendControl (request) {
		let requestId = randomUUID();
		this.ownRequests.add(requestId);
		this.write({ type: 'control_request', request_id: requestId, request });
	}

	writeUserMessage (text) {
		this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' });
		this.unconsumed++;
		this.busy = true;
		this.emitStatus();
	}

	// Starts a new conversation within the same process. Not counted as an
	// unconsumed message: the CLI handles "/clear" itself and never echoes it
	// back. The new session id arrives with the next `init` — not with
	// `conversation_reset`, whose new_conversation_id is a different id that
	// matches no session file (confirmed against the real CLI).
	clearConversation () {
		this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '/clear' }] }, parent_tool_use_id: null, session_id: '' });
		this.sessionId = null;
		this.busy = true;
		this.emitStatus();
	}

	// Applies whichever of model / effort / permission mode differ from the
	// running process's, live (works mid-turn too). No-op when stopped: the
	// next start takes them as arguments. emit: false when a prompt follows,
	// which reports the status itself.
	applyOptions ({ model, effort, permissionMode }, emit = true) {
		if (!this.child) return;
		if (model && model !== this.options.model) {
			this.options.model = model;
			this.sendControl({ subtype: 'set_model', model });
		}
		if (effort && effort !== this.options.effort) {
			this.options.effort = effort;
			// No dedicated control request for effort: it's a settings key,
			// confirmed applied by reading it back with get_settings.
			this.sendControl({ subtype: 'apply_flag_settings', settings: { effortLevel: effort } });
		}
		if (permissionMode && permissionMode !== this.options.permissionMode) {
			this.options.permissionMode = permissionMode;
			this.sendControl({ subtype: 'set_permission_mode', mode: permissionMode });
		}
		if (emit) this.emitStatus();
	}

	// Asks Claude to stop the current turn, keeping the process. Returns false
	// when there's nothing to interrupt. If no `result` follows in time, the
	// process is presumed hung and killed.
	interrupt () {
		if (!this.child || !this.isBusy()) return false;
		this.interruptRequested = true;
		this.sendControl({ subtype: 'interrupt' });
		clearTimeout(this.interruptTimer);
		let child = this.child;
		this.interruptTimer = setTimeout(() => {
			if (child !== this.child) return;
			this.broadcast({ type: 'error', message: 'claude did not respond to the interrupt in time and was killed' });
			this.expectedExit = { child, reason: 'killed' };
			forceKill(child);
		}, INTERRUPT_GRACE_MS);
		return true;
	}

	// Forwards a client's answer to a pending `can_use_tool` request. Returns
	// false if that request isn't pending (anymore): already answered from
	// another tab, or cancelled by an interrupt.
	answerPermission (requestId, response) {
		if (!this.child || !this.pendingPermissions.has(requestId)) return false;
		this.pendingPermissions.delete(requestId);
		this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
		this.emitStatus();
		return true;
	}

	handleLine (line) {
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			this.broadcast(line);
			return;
		}

		if (message.type === 'control_response') {
			let requestId = message.response?.request_id;
			if (this.ownRequests.delete(requestId)) {
				if (message.response.subtype === 'error') this.broadcast({ type: 'error', message: `claude control request failed: ${message.response.error}` });
				return;
			}
		} else if (message.type === 'control_request') {
			if (message.request?.subtype === 'can_use_tool') {
				this.pendingPermissions.set(message.request_id, line);
			} else {
				// Nothing else is supported here (hook callbacks, MCP...):
				// answer right away so the CLI doesn't wait forever.
				this.write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: `Unsupported control request: ${message.request?.subtype}` } });
				return;
			}
		} else if (message.type === 'control_cancel_request') {
			this.pendingPermissions.delete(message.request_id);
		} else if (message.type === 'system' && message.subtype === 'init') {
			// Also marks the start of a turn the CLI began on its own, e.g. for
			// a message left queued after an interrupt.
			this.busy = true;
			if (message.session_id) this.sessionId = message.session_id;
		} else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
			// The CLI can switch modes by itself (an accepted "setMode"
			// suggestion, leaving plan mode...).
			this.options.permissionMode = message.permissionMode;
		} else if (message.type === 'user' && message.isReplay && Array.isArray(message.message?.content)) {
			// Acknowledgment of one of our messages (the echoes of local
			// commands like set_model carry a plain string instead).
			this.unconsumed = Math.max(0, this.unconsumed - 1);
		} else if (message.type === 'result') {
			if (this.interruptRequested) {
				clearTimeout(this.interruptTimer);
				this.interruptRequested = false;
				// Messages still queued at that point are dropped by the CLI.
				this.unconsumed = 0;
			}
			this.busy = this.unconsumed > 0;
		}

		this.broadcast(line);
		// While stopping on purpose, whatever the CLI sends on its way out
		// (cancelled requests...) mustn't flash an intermediate status
		// before "stopped".
		if (!this.expectedExit) this.emitStatus();
	}
}
