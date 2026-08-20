// Reads Claude Code's own session/project persistence — no storage of our own.
// Sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, and
// known working directories are listed in ~/.claude.json's "projects" object.
// Encoding scheme and file shapes confirmed for real, see plan.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const DEFAULT_HOME_DIR = path.join(os.homedir(), '.claude');

// claudeHomeDir is configurable (see config.js's claudeHomeDir setting) since
// it's just where Claude Code happens to keep its own state on this machine;
// every function below takes it as an optional last argument, defaulting to
// the real ~/.claude for callers (tests, mainly) that don't care.
function projectsDir (homeDir) {
	return path.join(homeDir || DEFAULT_HOME_DIR, 'projects');
}

// ~/.claude.json sits next to ~/.claude, not inside it.
function claudeConfigPath (homeDir) {
	return path.join(path.dirname(homeDir || DEFAULT_HOME_DIR), '.claude.json');
}

export function encodeProjectPath (projectPath) {
	let normalized = projectPath.replace(/[\\/]+$/, '');
	return normalized.replace(/[/\\:._]/g, '-');
}

// Known working directories, deduped by their encoded folder name (Windows
// paths can appear twice in ~/.claude.json, once with \ and once with /),
// limited to the ones that actually have a history directory.
export async function listProjects (homeDir) {
	let existingEncoded;
	try {
		existingEncoded = new Set(await fs.readdir(projectsDir(homeDir)));
	} catch {
		return [];
	}

	let projectPaths;
	try {
		let config = JSON.parse(await fs.readFile(claudeConfigPath(homeDir), 'utf8'));
		projectPaths = Object.keys(config.projects || {});
	} catch {
		projectPaths = [];
	}

	let seen = new Set();
	let projects = [];
	for (let projectPath of projectPaths) {
		let encodedName = encodeProjectPath(projectPath);
		if (!existingEncoded.has(encodedName) || seen.has(encodedName)) continue;
		seen.add(encodedName);
		projects.push({ path: projectPath, encodedName });
	}
	return projects;
}

function extractText (content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		for (let item of content) if (item.type === 'text' && item.text) return item.text;
	}
	return '';
}

async function readSessionFile (filePath) {
	let raw;
	try {
		raw = await fs.readFile(filePath, 'utf8');
	} catch {
		return null;
	}
	let lines = raw.trim().split('\n').filter(Boolean);
	if (!lines.length) return null;

	let sessionId = path.basename(filePath, '.jsonl');
	let startTime = null;
	let lastTime = null;
	let lastMessagePreview = '';
	let aiTitle = '';
	let customTitle = '';
	let messageIds = new Set();
	let messages = [];
	// Summed across every assistant entry's own "usage" (confirmed present on
	// real captured session files: input_tokens/output_tokens, plus
	// cache_creation_input_tokens/cache_read_input_tokens, per API call — a
	// single user-visible turn can span several assistant entries when tools
	// are involved, each billed separately), so a resumed session can show its
	// real historical total rather than starting back at 0.
	let tokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };

	for (let line of lines) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type === 'ai-title') { aiTitle = entry.aiTitle; continue; }
		if (entry.type === 'custom-title') { customTitle = entry.customTitle; continue; }
		if (entry.type !== 'user' && entry.type !== 'assistant') continue;

		if (entry.timestamp) {
			if (!startTime || entry.timestamp < startTime) startTime = entry.timestamp;
			if (!lastTime || entry.timestamp > lastTime) lastTime = entry.timestamp;
		}
		if (entry.message?.id) messageIds.add(entry.message.id);

		if (entry.type === 'assistant' && entry.message?.usage) {
			tokenUsage.input += entry.message.usage.input_tokens || 0;
			tokenUsage.output += entry.message.usage.output_tokens || 0;
			tokenUsage.cacheCreation += entry.message.usage.cache_creation_input_tokens || 0;
			tokenUsage.cacheRead += entry.message.usage.cache_read_input_tokens || 0;
		}

		let text = extractText(entry.message?.content);
		if (!text) continue;
		if (entry.type === 'assistant') lastMessagePreview = text.slice(0, 100);
		messages.push({ role: entry.message?.role || entry.type, text });
	}

	return {
		sessionId, startTime, lastTime, lastMessagePreview, aiTitle, customTitle,
		messages, messageIds, tokenUsage,
	};
}

function isSubsetOf (a, b) {
	if (a.size > b.size) return false;
	for (let id of a) if (!b.has(id)) return false;
	return true;
}

// Left empty rather than defaulting to a placeholder here: this is server
// code with no notion of the client's chosen UI language, so the
// language-appropriate placeholder text is the front end's job (see
// defaultTitle() in front/index.js).
function withTitle (session) {
	let { messageIds, ...rest } = session;
	return { ...rest, title: rest.customTitle || rest.aiTitle || rest.lastMessagePreview || '' };
}

// A conversation resumed or forked can leave behind more than one file for
// what's really the same logical session; drop any whose message set is
// wholly contained in another's, keeping only the most complete version —
// same de-duplication approach as claude-code-webui.
export async function listSessions (cwd, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	let files;
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
	} catch {
		return [];
	}

	let sessions = (await Promise.all(files.map(f => readSessionFile(path.join(dir, f)))))
		.filter(Boolean);

	sessions.sort((a, b) => a.messageIds.size - b.messageIds.size);
	let unique = [];
	for (let session of sessions) {
		let isSubset = unique.some(other => isSubsetOf(session.messageIds, other.messageIds));
		if (!isSubset) unique.push(session);
	}

	unique.sort((a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0));
	return unique.map(withTitle);
}

export async function loadSession (cwd, sessionId, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	let session = await readSessionFile(path.join(dir, `${sessionId}.jsonl`));
	return session && withTitle(session);
}

// Appends a "custom-title" line, the same shape `claude` itself would write
// for a manual rename — read back by readSessionFile() above.
export async function setCustomTitle (cwd, sessionId, title, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	let filePath = path.join(dir, `${sessionId}.jsonl`);
	await fs.appendFile(filePath, JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n');
}

export async function deleteSession (cwd, sessionId, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	await fs.unlink(path.join(dir, `${sessionId}.jsonl`));
}

// Copies the session's raw file under a fresh id: a full, independent replay
// of the same conversation, exactly like continuing it as a new session would
// look on disk, rather than a shared/linked history.
export async function duplicateSession (cwd, sessionId, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	let newSessionId = randomUUID();
	await fs.copyFile(path.join(dir, `${sessionId}.jsonl`), path.join(dir, `${newSessionId}.jsonl`));
	return newSessionId;
}
