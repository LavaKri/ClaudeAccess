import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { listProjects, listSessions, loadSession, setCustomTitle, deleteSession, duplicateSession, moveSession } from './history.js';
import { getConfig, updateConfig, parseCliCommand } from './config.js';
import { CliProcess } from './cliProcess.js';
import { createOriginChecker, createHostChecker, rejectCrossOrigin, rejectForeignHost, requireJson } from './origin.js';

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

// See origin.js: no authentication here, so every request must be addressed
// to this server under one of its own names (DNS rebinding), and every
// state-changing request and the WebSocket upgrade must come from one of
// this server's own pages (cross-site requests).
const isOwnOrigin = createOriginChecker(config);
const isOwnHost = createHostChecker(config);

const app = express();
app.use(rejectForeignHost(isOwnHost));
app.use(rejectCrossOrigin(isOwnOrigin));
app.use(express.static(config.webdir));
app.use(express.json());

app.get('/api/config', async (req, res) => {
	res.json(await getConfig());
});

app.put('/api/config', requireJson, async (req, res) => {
	res.json(await updateConfig(req.body || {}));
});

app.get('/api/projects', async (req, res) => {
	let { claudeHomeDir } = await getConfig();
	res.json(await listProjects(claudeHomeDir));
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

app.put('/api/sessions/:sessionId/title', requireJson, async (req, res) => {
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

app.post('/api/sessions/:sessionId/move', requireJson, async (req, res) => {
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
// Browsers always send Origin on a WebSocket handshake and WebSockets aren't
// subject to CORS, so this check is the only thing stopping any web page
// from driving `claude` (with any permission mode) through this socket.
// No Origin at all means a non-browser local client, allowed as for REST.
// Host is checked too, as for REST (DNS rebinding).
const wss = new WebSocketServer({
	server,
	path: config.wsPath,
	verifyClient: ({ origin, req }) => (!origin || isOwnOrigin(origin)) && (!req.headers.host || isOwnHost(req.headers.host)),
});

function send (ws, payload) {
	if (ws.readyState === ws.OPEN) ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
}

// Every client sees the same conversation: there's a single claude process
// for the whole server (see cliProcess.js), whichever tab drives it.
function broadcast (payload) {
	for (let ws of wss.clients) send(ws, payload);
}

const cli = new CliProcess({
	resolveCommand: async () => parseCliCommand(useMockCli ? MOCK_CLI_COMMAND : (await getConfig()).cliCommand),
	getIdleTimeoutMs: async () => (await getConfig()).idleTimeoutMinutes * 60000,
	broadcast,
});

// Prompts are handled one at a time: one may have to wait for the process
// to stop (restart) before starting it again, and the next must see the
// result. Other requests (abort, permission answers) don't wait behind them.
let promptChain = Promise.resolve();

async function handlePrompt (ws, request) {
	try {
		let { confirmRestart } = await cli.prompt(request);
		// Sent back to the requesting client only, which asks its user and
		// re-sends the same prompt with confirmRestart: true — or drops it.
		if (confirmRestart) send(ws, { type: 'confirm_restart', reason: confirmRestart, status: cli.status });
	} catch (err) {
		send(ws, { type: 'error', message: `Failed to start claude process: ${err.message}` });
	}
}

wss.on('connection', ws => {
	// Brings a (re)connecting client up to date: process state, plus any
	// permission request or question still waiting for an answer, re-sent
	// exactly as the CLI first sent it.
	send(ws, cli.snapshot());
	for (let line of cli.pendingRequestLines()) send(ws, line);
	cli.setClientCount(wss.clients.size);

	ws.isAlive = true;
	ws.on('pong', () => { ws.isAlive = true; });

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
			promptChain = promptChain.then(() => handlePrompt(ws, request));
		} else if (request.type === 'options') {
			// Model / effort / permission mode changed while a process runs:
			// applied live, without waiting for the next prompt.
			cli.applyOptions(request);
		} else if (request.type === 'abort') {
			if (!cli.interrupt()) send(ws, { type: 'error', message: 'No prompt is currently running' });
		} else if (request.type === 'permission_response') {
			if (!cli.answerPermission(request.requestId, request.response)) {
				send(ws, { type: 'error', message: 'This request is no longer pending' });
			}
		} else if (request.type === 'ping') {
			// Application-level keepalive from the client (see front/WsClient.js),
			// which can't send protocol-level ping frames from a browser.
			send(ws, { type: 'pong' });
		} else {
			send(ws, { type: 'error', message: `Unknown message type: ${request.type}` });
		}
	});

	// Closing a tab no longer stops claude: the process outlives connections
	// (a running turn goes on, a pending question waits for the next client).
	ws.on('close', () => {
		cli.setClientCount(wss.clients.size);
	});
});

// Server-side liveness check, so "no client connected" (which lets the idle
// timeout stop a process waiting on a question) can be trusted: a browser
// that vanished without closing its socket (sleep, network loss) would
// otherwise keep counting as connected indefinitely. Browsers answer
// protocol-level pings on their own.
const CLIENT_PING_INTERVAL = 30000;
setInterval(() => {
	for (let ws of wss.clients) {
		if (!ws.isAlive) {
			ws.terminate();
			continue;
		}
		ws.isAlive = false;
		ws.ping();
	}
}, CLIENT_PING_INTERVAL);

// Stops claude cleanly on Ctrl+C / termination rather than relying on it
// noticing its stdin closing by itself.
for (let signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, async () => {
		await cli.stop('shutdown');
		process.exit(0);
	});
}

server.listen(config.port, config.host, () => {
	console.log(`Server listening on http://${config.host}:${config.port}`);
});
