// Reads Claude Code's own session/project persistence — no storage of our own.
// Sessions live at ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl, and
// known working directories are listed in ~/.claude.json's "projects" object.
// Encoding scheme and file shapes confirmed for real, see doc/plan.md.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
	return normalized.replace(/[^a-zA-Z0-9]/g, '-');
}

// Newest mtime among a project's session files — a cheap proxy for "most
// recently used" (a plain fs.stat per file, no JSONL parsing needed) used to
// sort the workspace list the same way the session list is sorted.
async function projectLastUsed (dir) {
	let files;
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
	} catch {
		return null;
	}
	let stats = await Promise.all(files.map(async f => {
		try {
			return (await fs.stat(path.join(dir, f))).mtimeMs;
		} catch {
			return 0;
		}
	}));
	return stats.length ? Math.max(...stats) : null;
}

// Real working directory of a history folder, read from the "cwd" field of its
// session files (the folder name alone can't be decoded back: "/", "\", ":",
// "." and "_" all become "-"). Tries the newest sessions first and gives up
// quietly (null) if none has a readable cwd.
async function historyFolderCwd (dir) {
	let files;
	try {
		files = (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'));
	} catch {
		return null;
	}
	let dated = await Promise.all(files.map(async f => {
		try {
			return { file: f, mtime: (await fs.stat(path.join(dir, f))).mtimeMs };
		} catch {
			return { file: f, mtime: 0 };
		}
	}));
	dated.sort((a, b) => b.mtime - a.mtime);
	for (let { file } of dated.slice(0, 5)) {
		let handle;
		try {
			handle = await fs.open(path.join(dir, file), 'r');
			let { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
			for (let line of buffer.toString('utf8', 0, bytesRead).split('\n')) {
				let match = /"cwd":("(?:[^"\\]|\\.)*")/.exec(line);
				if (match) return JSON.parse(match[1]);
			}
		} catch {
			// Unreadable file: try the next one.
		} finally {
			await handle?.close();
		}
	}
	return null;
}

// Every history folder Claude Code has on disk, whether or not ~/.claude.json
// lists it — used by the "existing workspaces" picker, never shown
// automatically. Folders whose real path can't be recovered are left out.
export async function listHistoryProjects (homeDir) {
	let names;
	try {
		names = await fs.readdir(projectsDir(homeDir));
	} catch {
		return [];
	}
	let projects = [];
	for (let encodedName of names) {
		let dir = path.join(projectsDir(homeDir), encodedName);
		let projectPath = await historyFolderCwd(dir);
		if (!projectPath) continue;
		projects.push({ path: projectPath, encodedName, lastUsed: await projectLastUsed(dir) });
	}
	projects.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
	return projects;
}

// Known working directories, deduped by their encoded folder name (Windows
// paths can appear twice in ~/.claude.json, once with \ and once with /),
// limited to the ones that actually have a history directory, sorted most
// recently used first (same ordering as listSessions below).
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
		let lastUsed = await projectLastUsed(path.join(projectsDir(homeDir), encodedName));
		projects.push({ path: projectPath, encodedName, lastUsed });
	}

	projects.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
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
	let runOptions = {};

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

		// "<synthetic>" is the placeholder model of messages the CLI writes itself.
		// Most are the "No response requested." filler (hidden by the text check
		// below, like any other model's), but some carry real information for the
		// user, such as "You've hit your session limit · resets 2:10pm": those are
		// kept, and shown without the meaningless "<synthetic>" model name.
		let synthetic = entry.type === 'assistant' && entry.message?.model === '<synthetic>';

		// Run options of the latest turn, as recorded by Claude Code itself on
		// the entries (full model id, effort, permission mode) — lets any
		// browser reopen a session with the options it was last run with. A
		// synthetic message isn't a real run, so it says nothing about them.
		if (!synthetic) {
			if (entry.permissionMode) runOptions.permissionMode = entry.permissionMode;
			if (entry.effort) runOptions.effort = entry.effort;
			if (entry.type === 'assistant' && entry.message?.model) runOptions.model = entry.message.model;
		}

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

		// Hidden noise: the bare "continue" prompt (sent automatically to resume
		// after a permission grant, or typed just to keep going) and the "No
		// response requested." reply, whichever model wrote it. A reply to a
		// "continue" that has real content is kept.
		let bareText = text.trim().toLowerCase();
		if (entry.type === 'user' && bareText === 'continue') continue;
		if (entry.type === 'assistant' && bareText === 'no response requested.') continue;
		if (entry.type === 'assistant') lastMessagePreview = text.slice(0, 100);
		messages.push({
			role: entry.message?.role || entry.type,
			text,
			model: synthetic ? undefined : entry.message?.model,
			effort: synthetic ? undefined : entry.effort,
		});
	}

	// Nothing readable (unparseable lines, or only hidden filler) and no title:
	// not worth listing as a blank entry.
	if (!messages.length && !aiTitle && !customTitle) return null;

	return {
		sessionId, startTime, lastTime, lastMessagePreview, aiTitle, customTitle,
		messages, messageIds, tokenUsage, runOptions,
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

	let sessions = (await Promise.all(files.map(f => readSessionFile(path.join(dir, f), cwd))))
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

// Ids of the session files really on disk for a directory, or null when the
// folder can't be read (so a caller never mistakes "unreadable" for "empty").
export async function listSessionIds (cwd, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	try {
		return (await fs.readdir(dir)).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length));
	} catch {
		return null;
	}
}

export async function loadSession (cwd, sessionId, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(cwd));
	let session = await readSessionFile(path.join(dir, `${sessionId}.jsonl`), cwd);
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

// Deletes a workspace entirely: its session history directory (recursively —
// wiping every .jsonl the way deleteSession does one at a time) plus its
// entry in ~/.claude.json's "projects" object, so `claude` itself no longer
// lists it either. Both steps are best-effort independently (missing
// directory or config entry isn't an error — the caller just wants the
// workspace gone, from whichever of the two places it still exists in).
export async function deleteProject (projectPath, homeDir) {
	let dir = path.join(projectsDir(homeDir), encodeProjectPath(projectPath));
	await fs.rm(dir, { recursive: true, force: true });

	let configPath = claudeConfigPath(homeDir);
	try {
		let config = JSON.parse(await fs.readFile(configPath, 'utf8'));
		if (config.projects && Object.prototype.hasOwnProperty.call(config.projects, projectPath)) {
			delete config.projects[projectPath];
			await fs.writeFile(configPath, JSON.stringify(config, null, 2));
		}
	} catch {
		// No ~/.claude.json, or no matching entry — nothing more to do.
	}
}
