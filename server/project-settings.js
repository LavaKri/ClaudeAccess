// Edits a workspace's shared Claude Code settings, <workspace>/.claude/settings.json
// (the versioned one, read by `claude` in the terminal as well as here). Only
// the PowerShell tool switch is touched; everything else in the file is kept.

import fs from 'node:fs/promises';
import path from 'node:path';

const POWERSHELL_KEY = 'CLAUDE_CODE_USE_POWERSHELL_TOOL';

function settingsFile (cwd) {
	return path.join(cwd, '.claude', 'settings.json');
}

// A file that exists but isn't a JSON object is reported, never overwritten.
async function readSettings (cwd) {
	let text;
	try {
		text = await fs.readFile(settingsFile(cwd), 'utf8');
	} catch (err) {
		if (err.code === 'ENOENT') return {};
		throw err;
	}
	let settings = JSON.parse(text);
	if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
		throw new Error(`${settingsFile(cwd)} is not a JSON object`);
	}
	return settings;
}

export async function getPowerShellToolDisabled (cwd) {
	let settings = await readSettings(cwd);
	return { disabled: settings.env?.[POWERSHELL_KEY] === '0', file: settingsFile(cwd) };
}

// Adds or removes env.CLAUDE_CODE_USE_POWERSHELL_TOOL = "0". An `env` block left
// empty is dropped, and so is a file left empty (it only held this switch).
export async function setPowerShellToolDisabled (cwd, disabled) {
	let settings = await readSettings(cwd);
	let env = { ...(settings.env ?? {}) };
	if (disabled) env[POWERSHELL_KEY] = '0';
	else delete env[POWERSHELL_KEY];
	if (Object.keys(env).length) settings.env = env;
	else delete settings.env;

	let file = settingsFile(cwd);
	if (Object.keys(settings).length) {
		await fs.mkdir(path.dirname(file), { recursive: true });
		await fs.writeFile(file, JSON.stringify(settings, null, 2) + '\n');
	} else {
		await fs.rm(file, { force: true });
	}
	return { disabled: Boolean(disabled), file };
}
