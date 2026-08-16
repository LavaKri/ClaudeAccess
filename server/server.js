import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
	host: 'localhost',
	port: 1080,
	webdir: 'front',
	wsPath: '/ws',
	// CLI invocation the server spawns for each prompt. Swap this for the real
	// `claude` binary once the streaming/permission protocol is stable (see plan.md).
	cliCommand: 'node',
	cliArgs: [path.join(__dirname, '..', 'mock', 'cli-mock.js')],
};

const app = express();
app.use(express.static(config.webdir));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: config.wsPath });

function send (ws, payload) {
	if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function runPrompt (ws, connectionState, { prompt, model, effort, cwd }) {
	if (connectionState.activeChild) {
		send(ws, { type: 'error', message: 'A prompt is already running on this connection' });
		return;
	}

	let child = spawn(config.cliCommand, [
		...config.cliArgs,
		'--prompt', prompt,
		'--model', model || 'sonnet',
		'--effort', effort || 'medium',
	], { cwd: cwd || process.cwd() });
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
	let connectionState = { activeChild: null };

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
		} else if (request.type === 'permission_response' || request.type === 'user_question_response') {
			if (connectionState.activeChild) {
				connectionState.activeChild.stdin.write(JSON.stringify(request) + '\n');
			} else {
				send(ws, { type: 'error', message: 'No prompt is currently running on this connection' });
			}
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
