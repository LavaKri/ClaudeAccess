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

function runPrompt (ws, { prompt, model, effort, cwd }) {
	let child = spawn(config.cliCommand, [
		...config.cliArgs,
		'--prompt', prompt,
		'--model', model || 'sonnet',
		'--effort', effort || 'medium',
	], { cwd: cwd || process.cwd() });

	let lines = createInterface({ input: child.stdout });
	lines.on('line', line => {
		if (line.trim() && ws.readyState === ws.OPEN) ws.send(line);
	});

	child.stderr.on('data', chunk => {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: 'error', message: chunk.toString() }));
		}
	});

	child.on('error', err => {
		if (ws.readyState === ws.OPEN) {
			ws.send(JSON.stringify({ type: 'error', message: `Failed to start claude process: ${err.message}` }));
		}
	});
}

wss.on('connection', ws => {
	ws.on('message', data => {
		let request;
		try {
			request = JSON.parse(data.toString());
		} catch {
			ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON message' }));
			return;
		}
		if (!request.prompt) {
			ws.send(JSON.stringify({ type: 'error', message: 'Missing "prompt" field' }));
			return;
		}
		runPrompt(ws, request);
	});
});

server.listen(config.port, config.host, () => {
	console.log(`Server listening on http://${config.host}:${config.port}`);
});
