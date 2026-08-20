// Global, persistent app preferences — stored outside the repo (in the user's
// home directory, like Claude Code's own ~/.claude.json) so a stray `git add`
// can never pick it up, and so it survives moving/reinstalling this project.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.claude-accessible');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULTS = {
	// Server's own listen address. Changing this only takes effect on the
	// next server restart — the HTTP/WS listener can't rebind itself live.
	host: 'localhost',
	port: 1080,
	// Directory Claude Code itself stores its state in — sessions live under
	// <claudeHomeDir>/projects/, and the known-workspaces list lives in
	// <parent of claudeHomeDir>/.claude.json. See history.js.
	claudeHomeDir: path.join(os.homedir(), '.claude'),
	// Free-form invocation, split into argv with parseCliCommand() below (no
	// shell involved) — lets the user tack on any global CLI flags they want,
	// or point this at something else entirely. To develop against the mock
	// instead of spending real usage, run `npm run start:mock` (or
	// `dev:mock`) rather than editing this — see server.js's --mock handling.
	cliCommand: 'claude',
	messagesPerPage: 20,
	sessionsPerPage: 10,
	// '' = auto-detect from the browser's languages at load time.
	language: '',
	// '' = auto-detect from the browser's prefers-color-scheme, falling back
	// to light (see front/theme.js, wired in with the CSS pass).
	theme: '',
	completionSound: true,
	// Applied to a brand new session that has no run-options history of its
	// own yet (see front/index.js's loadRunOptionsForSession).
	defaultModel: 'sonnet',
	defaultEffort: 'low',
	defaultPermissionMode: 'default',
};

function sanitize (patch) {
	let clean = {};
	for (let key of Object.keys(DEFAULTS)) {
		if (!(key in patch)) continue;
		let value = patch[key];
		if (key === 'messagesPerPage' || key === 'sessionsPerPage') {
			let n = Number(value);
			if (Number.isInteger(n) && n > 0) clean[key] = n;
		} else if (key === 'port') {
			let n = Number(value);
			if (Number.isInteger(n) && n > 0 && n <= 65535) clean[key] = n;
		} else if (key === 'completionSound') {
			clean[key] = Boolean(value);
		} else if (typeof value === 'string') {
			clean[key] = value;
		}
	}
	return clean;
}

export async function getConfig () {
	let stored = {};
	try {
		stored = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
	} catch {
		// No file yet, or unreadable/corrupt: fall back to defaults only.
	}
	return { ...DEFAULTS, ...sanitize(stored) };
}

export async function updateConfig (patch) {
	let next = { ...(await getConfig()), ...sanitize(patch) };
	await fs.mkdir(CONFIG_DIR, { recursive: true });
	await fs.writeFile(CONFIG_FILE, JSON.stringify(next, null, '\t'));
	return next;
}

// Splits a free-form CLI invocation string into argv tokens, respecting
// double-quoted segments (e.g. a path with spaces). No shell is ever
// involved in spawning it (see server.js) — so prompt text appended as its
// own argv element afterwards can't trigger shell injection regardless of
// its contents, no matter what this command string itself contains.
export function parseCliCommand (commandString) {
	let tokens = [];
	let regex = /"([^"]*)"|(\S+)/g;
	let match;
	while ((match = regex.exec(commandString))) {
		tokens.push(match[1] !== undefined ? match[1] : match[2]);
	}
	return tokens;
}
