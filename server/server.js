import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';
import { listProjects, listSessions, loadSession, setCustomTitle, deleteSession, duplicateSession, moveSession, deleteProject } from './history.js';
import { getConfig, updateConfig, parseCliCommand } from './config.js';

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

app.delete('/api/projects', async (req, res) => {
	let cwd = String(req.query.cwd || '');
	if (!cwd) {
		res.status(400).json({ error: 'Missing "cwd" query parameter' });
		return;
	}
	let { claudeHomeDir } = await getConfig();
	try {
		await deleteProject(cwd, claudeHomeDir);
	} catch (err) {
		res.status(500).json({ error: err.message });
		return;
	}
	res.json({ ok: true });
});

app.get('/api/sessions', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let { claudeHomeDir } = await getConfig();
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

app.post('/api/sessions/:sessionId/duplicate', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let { claudeHomeDir } = await getConfig();
	let newSessionId = await duplicateSession(cwd, req.params.sessionId, claudeHomeDir);
	res.json({ sessionId: newSessionId });
});

app.post('/api/sessions/:sessionId/move', async (req, res) => {
	let cwd = String(req.query.cwd || process.cwd());
	let targetCwd = String(req.body?.targetCwd || '').trim();
	if (!targetCwd) {
		res.status(400).json({ error: 'Missing "targetCwd" field' });
		return;
	}
	let { claudeHomeDir } = await getConfig();
	await moveSession(cwd, req.params.sessionId, targetCwd, claudeHomeDir);
	res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: config.wsPath });

function send (ws, payload) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

async function runPrompt (ws, connectionState, { prompt, model, effort, permissionMode, cwd, sessionId, allowedTools }) {
	if (connectionState.activeChild || connectionState.starting) {
		send(ws, { type: 'error', message: 'A prompt is already running on this connection' });
		return;
	}
	// Set synchronously (before the first await below) so a second 'prompt'
	// message arriving while getConfig() is still pending can't slip past the
	// guard above and spawn a second concurrent child on this connection.
	connectionState.starting = true;

	let { cliCommand } = await getConfig();
	let [command, ...baseArgs] = parseCliCommand(useMockCli ? MOCK_CLI_COMMAND : cliCommand);
	if (!command) {
		connectionState.starting = false;
		send(ws, { type: 'error', message: 'No CLI command configured' });
		return;
	}

	// `claude`'s actual invocation: prompt as a positional argument right
	// after -p (confirmed against the real CLI — see CLAUDE.md/plan.md),
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
	if (allowedTools?.length) args.push('--allowed-tools', allowedTools.join(','));

	// stdin explicitly ignored: nothing is ever written to it, and leaving it
	// as an open pipe makes the real `claude` binary wait a few seconds for
	// input before proceeding, emitting a stderr warning in the meantime that
	// this server would otherwise surface to the client as a spurious error.
	let child = spawn(command, args, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
	connectionState.starting = false;
	connectionState.activeChild = child;

	let lines = createInterface({ input: child.stdout });
	lines.on('line', line => {
		if (line.trim() && ws.readyState === ws.OPEN) ws.send(line);
	});

	child.stderr.on('data', chunk => {
		send(ws, { type: 'error', message: chunk.toString() });
	});

	child.on('error', err => {
		connectionState.activeChild = null;
		send(ws, { type: 'error', message: `Failed to start claude process: ${err.message}` });
	});

	child.on('exit', () => {
		connectionState.activeChild = null;
	});
}

function abortPrompt (ws, connectionState) {
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
