import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { listProjects, listHistoryProjects, listSessions, loadSession, setCustomTitle, deleteSession, deleteProject, listSessionIds } from './history.js';
import { getConfig, updateConfig, parseCliCommand } from './config.js';
import { getWorkspaceStore, saveWorkspaceStore } from './workspaces.js';
import { getSessionOptions, saveSessionOptions, pruneSessionOptions, deleteSessionOptions, deleteWorkspaceSessionOptions } from './session-options.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Dev-only escape hatch: `npm run start:mock` (or `dev:mock`) runs the
// server against mock/cli-mock.js instead of the real `claude` CLI, without
// touching the persisted cliCommand config — useful for frontend/protocol
// work without consuming real usage. See CLAUDE.md.
const MOCK_CLI_COMMAND = `node "${path.join(__dirname, '..', 'mock', 'cli-mock.js')}"`;
const useMockCli = process.argv.includes('--mock');

// host/port come from config (see the options page's "advanced settings");
// read once at startup since the HTTP/WS listener can't rebind itself live —
// changing them only takes effect on the next server restart.
const { host: startupHost, port: startupPort } = await getConfig();

const config = {
	host: startupHost,
	port: startupPort,
	webdir: 'front',
	wsPath: '/ws',
};

const app = express();
app.use(express.static(config.webdir));
app.use(express.json());

app.get('/api/config', async (req, res) => {
	res.json(await getConfig());
});

app.put('/api/config', async (req, res) => {
	res.json(await updateConfig(req.body || {}));
});

// no-store: the list changes as a side effect of deleteProject() below, and a
// stale cached response (browser HTTP cache keyed on this same URL) would
// otherwise make a just-deleted workspace linger in the UI until a hard
// reload — a plain F5 wasn't enough to reproduce this reliably.
app.get('/api/projects', async (req, res) => {
	let { claudeHomeDir } = await getConfig();
	res.set('Cache-Control', 'no-store');
	res.json(await listProjects(claudeHomeDir));
});

// The user's own workspace list and its per-workspace UI state (see
// workspaces.js). The whole store is read and replaced at once: it's tiny.
app.get('/api/workspaces', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(await getWorkspaceStore());
});

app.put('/api/workspaces', async (req, res) => {
	res.json(await saveWorkspaceStore(req.body));
});

// Model / effort / permission mode remembered per session (session-options.js).
app.get('/api/session-options', async (req, res) => {
	res.set('Cache-Control', 'no-store');
	res.json(await getSessionOptions(String(req.query.cwd || process.cwd())));
});

app.put('/api/session-options/:sessionId', async (req, res) => {
	res.json(await saveSessionOptions(String(req.query.cwd || process.cwd()), req.params.sessionId, req.body));
});

// Every history folder on disk, for the "existing workspaces" picker.
app.get('/api/history-projects', async (req, res) => {
	let { claudeHomeDir } = await getConfig();
	res.set('Cache-Control', 'no-store');
	res.json(await listHistoryProjects(claudeHomeDir));
});

app.delete('/api/projects', async (req, res) => {
	let cwd = String(req.query.cwd || '');
	if (!cwd) {
		res.status(400).json({ error: 'Missing "cwd" query parameter' });
		return;
	}
	let { claudeHomeDir } = await getConfig();
	try {
		await deleteProject(cwd, claudeHomeDir);
		await deleteWorkspaceSessionOptions(cwd);
	} catch (err) {
		res.status(500).json({ error: err.message });
		return;
	}
	res.json({ ok: true });
});

app.get('/api/sessions', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let { claudeHomeDir } = await getConfig();
	// Listing is the moment to forget the options of sessions that no longer
	// exist: it happens whenever a workspace is opened or refreshed.
	let existingIds = await listSessionIds(cwd, claudeHomeDir);
	if (existingIds) await pruneSessionOptions(cwd, existingIds);
	res.json(await listSessions(cwd, claudeHomeDir));
});

app.get('/api/sessions/:sessionId', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let { claudeHomeDir } = await getConfig();
	let session = await loadSession(cwd, req.params.sessionId, claudeHomeDir);
	if (!session) {
		res.status(404).json({ error: 'Session not found' });
		return;
	}
	res.json(session);
});

app.put('/api/sessions/:sessionId/title', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let title = String(req.body?.title || '').trim();
	if (!title) {
		res.status(400).json({ error: 'Missing "title" field' });
		return;
	}
	let { claudeHomeDir } = await getConfig();
	await setCustomTitle(cwd, req.params.sessionId, title, claudeHomeDir);
	res.json({ ok: true });
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let { claudeHomeDir } = await getConfig();
	await deleteSession(cwd, req.params.sessionId, claudeHomeDir);
	await deleteSessionOptions(cwd, req.params.sessionId);
	res.json({ ok: true });
});

// Native dialog description text, in the same two languages as front/lang/ —
// duplicated here rather than shared with those JSON files because this
// string is baked into a PowerShell script, not rendered through the front
// end's own i18n runtime. Client passes its current UI language as ?lang=.
const PICK_FOLDER_DESCRIPTIONS = {
	en: 'Choose a working folder',
	fr: 'Choisir un dossier de travail',
};

// Opens the real Windows folder-browser dialog server-side (this app is
// always self-hosted on the same machine as the browser using it, so that's
// fair game — unlike a public web app, which couldn't do this at all: a
// browser sandbox only ever exposes relative File info, never an absolute OS
// path). Blocks this one request until the user picks a folder or cancels;
// resolves to { path: null } on cancel.
app.post('/api/pick-folder', async (req, res) => {
	let description = PICK_FOLDER_DESCRIPTIONS[req.query.lang] || PICK_FOLDER_DESCRIPTIONS.en;
	let script = [
		'Add-Type -AssemblyName System.Windows.Forms',
		'$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
		`$dialog.Description = '${description.replace(/'/g, "''")}'`,
		'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }',
	].join('; ');

	let child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
	let output = '';
	child.stdout.on('data', chunk => { output += chunk; });
	child.on('error', err => {
		res.status(500).json({ error: err.message });
	});
	child.on('close', () => {
		res.json({ path: output.trim() || null });
	});
});

// Errors raised while handling a request, answered as JSON like the rest of
// the API (Express' default would be an HTML page). A client error, such as a
// body that isn't a JSON object, is the caller's mistake: 4xx, no trace on the
// console. Anything else is a real failure: logged, then a plain 500.
app.use((err, req, res, next) => {
	if (res.headersSent) {
		next(err);
		return;
	}
	let status = Number(err.status ?? err.statusCode);
	if (status >= 400 && status < 500) {
		res.status(status).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : String(err.message || 'Bad request') });
		return;
	}
	console.error(err);
	res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: config.wsPath });

function send (ws, payload) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

// Logs every tool error the CLI reports (tool name + start of its text) to the
// server console, so the real wording of genuine permission denials can be
// collected over time. Purely informational: the front end decides what to do
// with them. `toolNames` maps tool_use ids to names for this child process.
function logToolError (line, toolNames) {
	if (!line.includes('"tool_use"') && !line.includes('"is_error":true')) return;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		return;
	}
	for (let item of message.message?.content ?? []) {
		if (item.type === 'tool_use') {
			toolNames.set(item.id, item.name);
		} else if (item.type === 'tool_result' && item.is_error) {
			let text = typeof item.content === 'string' ? item.content : JSON.stringify(item.content);
			console.log(`[tool error] ${toolNames.get(item.tool_use_id) ?? '?'}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
		}
	}
}

// Waits for a child that has already delivered its result to exit (it can
// linger a moment, e.g. to emit a prompt suggestion), killing it if it takes
// too long, so its trailing output is flushed before the next run starts.
function waitForExit (child, timeoutMs = 2000) {
	return new Promise(resolve => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		let timer = setTimeout(() => {
			child.kill();
			resolve();
		}, timeoutMs);
		child.once('exit', () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function runPrompt (ws, connectionState, { prompt, model, effort, permissionMode, cwd, sessionId, fork, allowedTools }) {
	// A previous child that already sent its result isn't "running" any more,
	// even if its process hasn't quite exited: the front end re-enables Send at
	// the result, so a prompt arriving right then must be accepted.
	let runningChild = connectionState.activeChild && !connectionState.activeChild.resultSeen;
	if (runningChild || connectionState.starting) {
		send(ws, { type: 'error', message: 'A prompt is already running on this connection' });
		return;
	}
	// Set synchronously (before the first await below) so a second 'prompt'
	// message arriving while getConfig() is still pending can't slip past the
	// guard above and spawn a second concurrent child on this connection.
	connectionState.starting = true;
	connectionState.cancelStart = false;

	if (connectionState.activeChild) await waitForExit(connectionState.activeChild);

	let { cliCommand } = await getConfig();
	let [command, ...baseArgs] = parseCliCommand(useMockCli ? MOCK_CLI_COMMAND : cliCommand);
	if (!command) {
		connectionState.starting = false;
		send(ws, { type: 'error', message: 'No CLI command configured' });
		return;
	}
	// An abort that arrived while the start was pending (see abortPrompt).
	if (connectionState.cancelStart) {
		connectionState.starting = false;
		connectionState.cancelStart = false;
		return;
	}

	// `claude`'s actual invocation: prompt as a positional argument right
	// after -p (confirmed against the real CLI — see CLAUDE.md/doc/plan.md),
	// --output-format stream-json requires --verbose or the CLI refuses to
	// start. --allowed-tools kept last since it's a variadic option.
	let args = [
		...baseArgs,
		'-p', prompt,
		'--output-format', 'stream-json',
		'--verbose',
		'--model', model || 'sonnet',
		'--effort', effort || 'low',
		'--permission-mode', permissionMode || 'default',
	];
	if (sessionId) args.push('--resume', sessionId);
	// New branch: the CLI copies the session's history under a new session id and
	// leaves the original untouched. Meaningless without a session to resume.
	if (sessionId && fork) args.push('--fork-session');
	if (allowedTools?.length) args.push('--allowed-tools', allowedTools.join(','));

	// stdin explicitly ignored: nothing is ever written to it, and leaving it
	// as an open pipe makes the real `claude` binary wait a few seconds for
	// input before proceeding, emitting a stderr warning in the meantime that
	// this server would otherwise surface to the client as a spurious error.
	let child = spawn(command, args, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
	connectionState.starting = false;
	connectionState.activeChild = child;

	let toolNames = new Map();
	let lines = createInterface({ input: child.stdout });
	lines.on('line', line => {
		if (!line.trim()) return;
		logToolError(line, toolNames);
		if (line.includes('"type":"result"')) {
			try {
				if (JSON.parse(line).type === 'result') child.resultSeen = true;
			} catch {
				// Not JSON after all: nothing to remember.
			}
		}
		if (ws.readyState === ws.OPEN) ws.send(line);
	});

	child.stderr.on('data', chunk => {
		send(ws, { type: 'error', message: chunk.toString() });
	});

	// Only clear the slot if it still holds this child: a finished child can exit
	// after the next run has already taken its place.
	child.on('error', err => {
		if (connectionState.activeChild === child) connectionState.activeChild = null;
		send(ws, { type: 'error', message: `Failed to start claude process: ${err.message}` });
	});

	child.on('exit', () => {
		if (connectionState.activeChild === child) connectionState.activeChild = null;
	});
}

function abortPrompt (ws, connectionState) {
	// A run that is still starting has no live child to kill yet: flag it so
	// runPrompt gives up instead of spawning one.
	if (connectionState.starting) {
		connectionState.cancelStart = true;
		send(ws, { type: 'result', subtype: 'aborted' });
		return;
	}
	if (!connectionState.activeChild) {
		send(ws, { type: 'error', message: 'No prompt is currently running on this connection' });
		return;
	}
	connectionState.activeChild.kill();
	connectionState.activeChild = null;
	send(ws, { type: 'result', subtype: 'aborted' });
}

wss.on('connection', ws => {
	let connectionState = { activeChild: null, starting: false };

	ws.on('message', data => {
		let request;
		try {
			request = JSON.parse(data.toString());
		} catch {
			send(ws, { type: 'error', message: 'Invalid JSON message' });
			return;
		}

		if (request.type === 'prompt') {
			if (!request.prompt) {
				send(ws, { type: 'error', message: 'Missing "prompt" field' });
				return;
			}
			runPrompt(ws, connectionState, request);
		} else if (request.type === 'abort') {
			abortPrompt(ws, connectionState);
		} else {
			send(ws, { type: 'error', message: `Unknown message type: ${request.type}` });
		}
	});

	ws.on('close', () => {
		connectionState.activeChild?.kill();
	});
});

server.listen(config.port, config.host, () => {
	console.log(`Server listening on http://${config.host}:${config.port}`);
});
