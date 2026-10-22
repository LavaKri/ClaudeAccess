// Reads Claude Code's own session/project persistence — no storage of our own.
// Sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, and
// known working directories are listed in ~/.claude.json's "projects" object.
// Encoding scheme and file shapes confirmed for real, see plan.md.

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
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

// Claude Code's own scheme: every character other than an ASCII letter or
// digit becomes "-" (spaces, accents, parentheses... included). Lossy, so
// never decoded back: a history directory's real path is read from its
// session files instead (see listProjects below). Claude Code may also
// shorten very long paths with a hash suffix, which this doesn't reproduce —
// such directories are still found through their session files; only a
// brand new workspace with a very long path would be looked up in the wrong
// place.
export function encodeProjectPath (projectPath) {
	let normalized = projectPath.replace(/[\\/]+$/, '');
	return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

// Comparison key for two spellings of the same path (trailing separator,
// slash style, and on Windows, case).
export function pathKey (projectPath) {
	let key = projectPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
	return process.platform === 'win32' ? key.toLowerCase() : key;
}

// Path key -> history directory name, as found by the last listProjects()
// scan, so lookups by path don't depend on reproducing Claude Code's
// encoding exactly. One map per claudeHomeDir.
let projectDirNames = new Map();

// History directory of a working directory: the one found by the last scan
// (scanning first if none ran yet, e.g. right after a server restart), else
// the encoded path, which is where `claude` itself would create it.
async function projectDir (cwd, homeDir) {
	let homeKey = homeDir || DEFAULT_HOME_DIR;
	if (!projectDirNames.has(homeKey)) await listProjects(homeDir);
	let dirName = projectDirNames.get(homeKey)?.get(pathKey(cwd)) || encodeProjectPath(cwd);
	return path.join(projectsDir(homeDir), dirName);
}

// First top-level "cwd" field in a session file — every user/assistant entry
// records the working directory `claude` ran in. Reads line by line and stops
// as soon as it's found, rather than loading the whole (possibly large) file.
async function readSessionCwd (filePath) {
	let stream = createReadStream(filePath, { encoding: 'utf8' });
	let lines = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (let line of lines) {
			if (!line.includes('"cwd"')) continue;
			try {
				let entry = JSON.parse(line);
				if (typeof entry.cwd === 'string') return entry.cwd;
			} catch {
				// Malformed line: keep looking.
			}
		}
	} catch {
		// Unreadable file: no cwd.
	} finally {
		lines.close();
		stream.destroy();
	}
	return null;
}

// Session files of a history directory with their mtime, newest first.
async function listSessionFiles (dir) {
	let files;
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
	} catch {
		return [];
	}
	let entries = await Promise.all(files.map(async f => {
		let filePath = path.join(dir, f);
		try {
			return { filePath, mtimeMs: (await fs.stat(filePath)).mtimeMs };
		} catch {
			return null;
		}
	}));
	return entries.filter(Boolean).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// The working directory a history directory belongs to. A session's "cwd"
// isn't always the directory it's filed under (a session moved here before
// moveSession() rewrote it, or one where `claude` was started from a
// subdirectory), so the first one whose encoding matches the directory name
// wins; failing that, a ~/.claude.json path that encodes to it; failing that
// (a hash-shortened long path), the newest session's cwd as a best guess —
// flagged as such, see listProjects.
async function resolveProjectPath (dirName, sessionFiles, configPaths) {
	let fallback = null;
	for (let { filePath } of sessionFiles) {
		let cwd = await readSessionCwd(filePath);
		if (!cwd) continue;
		if (encodeProjectPath(cwd) === dirName) return { path: cwd, exact: true };
		fallback ??= cwd;
	}
	let configPath = configPaths.find(p => encodeProjectPath(p) === dirName);
	if (configPath) return { path: configPath, exact: true };
	return fallback && { path: fallback, exact: false };
}

// Every history directory holding at least one session, with its real path
// (read from its session files, see resolveProjectPath), sorted most recently
// used first — newest session file mtime, a cheap proxy that needs no JSONL
// parsing. When ~/.claude.json lists the same path (possibly twice on
// Windows, once with \ and once with /), its first spelling is kept, so
// client-side data keyed by path (custom names...) stays stable. A best-guess
// path that another directory already resolved to for sure is dropped rather
// than listed twice: that's a directory whose only sessions were moved in
// from that other workspace, before moveSession() rewrote their "cwd" — its
// real path can't be known.
export async function listProjects (homeDir) {
	let dirNames;
	try {
		dirNames = await fs.readdir(projectsDir(homeDir));
	} catch {
		return [];
	}

	let configPaths;
	try {
		let config = JSON.parse(await fs.readFile(claudeConfigPath(homeDir), 'utf8'));
		configPaths = Object.keys(config.projects || {});
	} catch {
		configPaths = [];
	}

	let resolved = (await Promise.all(dirNames.map(async dirName => {
		let sessionFiles = await listSessionFiles(path.join(projectsDir(homeDir), dirName));
		if (!sessionFiles.length) return null;
		let resolvedPath = await resolveProjectPath(dirName, sessionFiles, configPaths);
		if (!resolvedPath) return null;
		let projectPath = configPaths.find(p => pathKey(p) === pathKey(resolvedPath.path)) || resolvedPath.path;
		return { path: projectPath, encodedName: dirName, lastUsed: sessionFiles[0].mtimeMs, exact: resolvedPath.exact };
	}))).filter(Boolean);

	// Exact matches first, so they claim their path before any best guess.
	resolved.sort((a, b) => b.exact - a.exact);
	let dirNamesByKey = new Map();
	let projects = [];
	for (let { exact, ...project } of resolved) {
		let key = pathKey(project.path);
		if (dirNamesByKey.has(key)) continue;
		dirNamesByKey.set(key, project.encodedName);
		projects.push(project);
	}
	projectDirNames.set(homeDir || DEFAULT_HOME_DIR, dirNamesByKey);

	projects.sort((a, b) => b.lastUsed - a.lastUsed);
	return projects;
}

function extractText (content) {
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		for (let item of content) if (item.type === 'text' && item.text) return item.text;
	}
	return '';
}

// Strips cwd from an absolute path read by a tool, so a resumed session's
// "files read" list shows a path relative to the project root, same as the
// live stream does — see front/index.js's toProjectRelativePath(). Falls back
// to the original path unchanged if it isn't actually under cwd, or if cwd
// isn't known (listSessions() doesn't need it for anything else).
function toProjectRelativePath (absolutePath, cwd) {
	if (!cwd) return absolutePath;
	// Workspace paths and a tool's own absolute paths don't necessarily use the
	// same slash style (e.g. a workspace added as "C:/foo/bar" vs. a tool
	// reporting "C:\foo\bar\file.cpp") — compare on a forward-slash-normalized
	// form so the prefix still matches, but keep the original separators in the
	// returned relative path (whatever the tool itself used).
	let normalize = p => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
	let normalizedCwd = normalize(cwd);
	if (normalize(absolutePath).slice(0, normalizedCwd.length) !== normalizedCwd) return absolutePath;
	return absolutePath.slice(cwd.replace(/[\\/]+$/, '').length).replace(/^[\\/]+/, '');
}

// Same classification as the live stream's cacheToolUse() in front/index.js
// (Read w/ file_path -> file, "command" input -> command, else the tool's own
// name) — kept as a small server-side duplicate rather than shared code,
// consistent with this project's no-bundler/no-shared-module setup.
function classifyToolUse (name, input, cwd) {
	if (name === 'Read' && typeof input?.file_path === 'string') {
		return { kind: 'file', label: toProjectRelativePath(input.file_path, cwd) };
	}
	if (typeof input?.command === 'string') return { kind: 'command', label: input.command };
	return { kind: 'other', label: name };
}

async function readSessionFile (filePath, cwd) {
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

		// Auto-injected by Claude Code itself between turns (e.g. a background
		// shell task reporting it stopped) rather than actually typed by the
		// user — tagged with origin.kind on the entry (confirmed on a real
		// captured session file). Surfaced as its own "notification" role
		// instead of "user", so the front end doesn't attribute it to the user
		// under a "Vous dites" heading.
		if (entry.type === 'user' && entry.origin?.kind === 'task-notification') {
			let notificationText = extractText(entry.message?.content);
			if (notificationText) messages.push({ role: 'notification', text: notificationText });
			continue;
		}

		// A single content array element is either a text block or a tool_use
		// block, never both together (confirmed on a real captured session
		// file) — tool_use blocks carry no usable "text", so they're handled
		// here as their own "tool" role entry instead of falling through to
		// the text extraction below.
		let toolUse = entry.type === 'assistant' && (entry.message?.content ?? []).find(item => item.type === 'tool_use');
		if (toolUse) {
			messages.push({ role: 'tool', tool: classifyToolUse(toolUse.name, toolUse.input, cwd) });
			continue;
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
	let dir = await projectDir(cwd, homeDir);
	let files;
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
	} catch {
		return [];
	}

	let sessions = (await Promise.all(files.map(f => readSessionFile(path.join(dir, f), cwd))))
		.filter(Boolean);

	sessions.sort((a, b) => a.messageIds.size - b.messageIds.size);
	let unique = [];
	for (let session of sessions) {
		let isSubset = unique.some(other => isSubsetOf(session.messageIds, other.messageIds));
		if (!isSubset) unique.push(session);
	}

	// Most recently active first (lastTime, the date shown in the list), not
	// most recently started: an old session resumed yesterday belongs on top.
	unique.sort((a, b) => new Date(b.lastTime || 0) - new Date(a.lastTime || 0));
	return unique.map(withTitle);
}

export async function loadSession (cwd, sessionId, homeDir) {
	let dir = await projectDir(cwd, homeDir);
	let session = await readSessionFile(path.join(dir, `${sessionId}.jsonl`), cwd);
	return session && withTitle(session);
}

// Appends a "custom-title" line, the same shape `claude` itself would write
// for a manual rename — read back by readSessionFile() above. The file's
// mtime is restored afterwards: it's what orders the workspace list (see
// listProjects), and a rename isn't "using" the workspace.
export async function setCustomTitle (cwd, sessionId, title, homeDir) {
	let dir = await projectDir(cwd, homeDir);
	let filePath = path.join(dir, `${sessionId}.jsonl`);
	let { atime, mtime } = await fs.stat(filePath);
	await fs.appendFile(filePath, JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n');
	await fs.utimes(filePath, atime, mtime);
}

export async function deleteSession (cwd, sessionId, homeDir) {
	let dir = await projectDir(cwd, homeDir);
	await fs.unlink(path.join(dir, `${sessionId}.jsonl`));
}

// Copies the session's raw file under a fresh id: a full, independent replay
// of the same conversation, exactly like continuing it as a new session would
// look on disk, rather than a shared/linked history.
export async function duplicateSession (cwd, sessionId, homeDir) {
	let dir = await projectDir(cwd, homeDir);
	let newSessionId = randomUUID();
	await fs.copyFile(path.join(dir, `${sessionId}.jsonl`), path.join(dir, `${newSessionId}.jsonl`));
	return newSessionId;
}

// Rewrites an entry's "cwd" from one workspace to another, keeping any
// subdirectory part (`claude` may have been started from one). Anything not
// under the source workspace is left as it was.
function relocateCwd (entryCwd, sourceCwd, targetCwd) {
	let sourceKey = pathKey(sourceCwd);
	let entryKey = pathKey(entryCwd);
	if (entryKey !== sourceKey && !entryKey.startsWith(sourceKey + '/')) return entryCwd;
	let rest = entryCwd.replace(/[\\/]+$/, '').slice(sourceCwd.replace(/[\\/]+$/, '').length);
	return targetCwd.replace(/[\\/]+$/, '') + rest;
}

// Moves the session's raw file to another project's history directory,
// keeping the same session id: a session is identified only by its filename,
// never by anything tied to the workspace, so relocating the file is all
// `claude --resume` needs to pick it up from its new home. The entries' own
// "cwd" fields are rewritten to the target workspace on the way (only those
// lines; every other line is copied as is), so the file says where it now
// belongs — that field is how listProjects() finds a history directory's
// real path. The target directory is created if this is the first session
// ever moved there (mirrors what `claude` itself does the first time it runs
// in a fresh cwd), and the original mtime is kept: moving a session isn't
// using it.
export async function moveSession (cwd, sessionId, targetCwd, homeDir) {
	let sourcePath = path.join(await projectDir(cwd, homeDir), `${sessionId}.jsonl`);
	let targetDir = await projectDir(targetCwd, homeDir);
	let targetPath = path.join(targetDir, `${sessionId}.jsonl`);

	let { atime, mtime } = await fs.stat(sourcePath);
	let lines = (await fs.readFile(sourcePath, 'utf8')).split('\n').map(line => {
		if (!line.includes('"cwd"')) return line;
		try {
			let entry = JSON.parse(line);
			if (typeof entry.cwd !== 'string') return line;
			let newCwd = relocateCwd(entry.cwd, cwd, targetCwd);
			return newCwd === entry.cwd ? line : JSON.stringify({ ...entry, cwd: newCwd });
		} catch {
			return line;
		}
	});

	await fs.mkdir(targetDir, { recursive: true });
	await fs.writeFile(targetPath, lines.join('\n'));
	await fs.utimes(targetPath, atime, mtime);
	await fs.unlink(sourcePath);
}
