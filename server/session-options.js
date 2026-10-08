// Model, effort and permission mode last chosen for each session — stored next
// to config.json (not in the browser), so a session reopens with the same
// options from any browser. One file per workspace, so it can be checked
// against that workspace's real sessions and cleaned up with it.
//
// Shape of a file: { [sessionId]: { model, effort, permissionMode } }.

import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { encodeProjectPath } from './history.js';

const SESSION_OPTIONS_DIR = path.join(CONFIG_DIR, 'session-options');
const KEYS = ['model', 'effort', 'permissionMode'];

// Same folder-name encoding as `claude`'s own history folders, lowercased
// because Windows paths are case-insensitive.
function fileFor (cwd) {
	return path.join(SESSION_OPTIONS_DIR, `${encodeProjectPath(cwd).toLowerCase()}.json`);
}

function sanitizeOptions (options) {
	let clean = {};
	for (let key of KEYS) {
		if (typeof options?.[key] === 'string' && options[key]) clean[key] = options[key];
	}
	return clean;
}

export async function getSessionOptions (cwd) {
	try {
		let raw = JSON.parse(await fs.readFile(fileFor(cwd), 'utf8'));
		let result = {};
		for (let [sessionId, options] of Object.entries(raw ?? {})) result[sessionId] = sanitizeOptions(options);
		return result;
	} catch {
		// No file yet, or unreadable/corrupt: nothing remembered.
		return {};
	}
}

async function writeSessionOptions (cwd, all) {
	if (!Object.keys(all).length) {
		await fs.rm(fileFor(cwd), { force: true });
		return;
	}
	await fs.mkdir(SESSION_OPTIONS_DIR, { recursive: true });
	await fs.writeFile(fileFor(cwd), JSON.stringify(all, null, '\t'));
}

export async function saveSessionOptions (cwd, sessionId, options) {
	let all = await getSessionOptions(cwd);
	all[sessionId] = sanitizeOptions(options);
	await writeSessionOptions(cwd, all);
	return all[sessionId];
}

// Drops the entries of sessions that no longer exist (deleted, or removed
// outside the app). `existingIds` must be the ids of the session files really
// on disk, not the de-duplicated list shown to the user, which leaves out
// sessions that still exist.
export async function pruneSessionOptions (cwd, existingIds) {
	let all = await getSessionOptions(cwd);
	let existing = new Set(existingIds);
	let changed = false;
	for (let sessionId of Object.keys(all)) {
		if (!existing.has(sessionId)) {
			delete all[sessionId];
			changed = true;
		}
	}
	if (changed) await writeSessionOptions(cwd, all);
}

export async function deleteSessionOptions (cwd, sessionId) {
	await pruneSessionOptions(cwd, Object.keys(await getSessionOptions(cwd)).filter(id => id !== sessionId));
}

// Removes a whole workspace's file (its history was deleted).
export async function deleteWorkspaceSessionOptions (cwd) {
	await fs.rm(fileFor(cwd), { force: true });
}
