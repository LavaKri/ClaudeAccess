// The user's own list of workspaces, with the UI state tied to each one —
// stored next to config.json (not in the browser), so it follows the app's
// config directory instead of one particular browser, profile or port.
//
// Shape: { workspaces: [{ path, name?, lastSessionId? }], lastWorkspace }.
// `exists` is false until the file has been written once: the front end uses
// that to migrate what an older version kept in the browser's localStorage.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const WORKSPACES_FILE = path.join(CONFIG_DIR, 'workspaces.json');

function normalizePath (workspacePath) {
	return workspacePath.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function sanitize (data) {
	let seen = new Set();
	let workspaces = [];
	for (let entry of Array.isArray(data?.workspaces) ? data.workspaces : []) {
		if (typeof entry?.path !== 'string' || !entry.path.trim()) continue;
		let key = normalizePath(entry.path);
		if (seen.has(key)) continue;
		seen.add(key);
		let clean = { path: entry.path };
		if (typeof entry.name === 'string' && entry.name.trim()) clean.name = entry.name.trim();
		if (typeof entry.lastSessionId === 'string' && entry.lastSessionId) clean.lastSessionId = entry.lastSessionId;
		workspaces.push(clean);
	}
	let lastWorkspace = typeof data?.lastWorkspace === 'string' ? data.lastWorkspace : '';
	return { workspaces, lastWorkspace };
}

export async function getWorkspaceStore () {
	let raw;
	try {
		raw = JSON.parse(await fs.readFile(WORKSPACES_FILE, 'utf8'));
	} catch {
		// No file yet, or unreadable/corrupt: report it as not existing.
		return { exists: false, workspaces: [], lastWorkspace: '' };
	}
	return { exists: true, ...sanitize(raw) };
}

export async function isKnownWorkspace (workspacePath) {
	let key = normalizePath(workspacePath);
	return (await getWorkspaceStore()).workspaces.some(entry => normalizePath(entry.path) === key);
}

export async function saveWorkspaceStore (data) {
	let clean = sanitize(data);
	await fs.mkdir(CONFIG_DIR, { recursive: true });
	await fs.writeFile(WORKSPACES_FILE, JSON.stringify(clean, null, '\t'));
	return { exists: true, ...clean };
}
