// Builds the --allowed-tools rules offered by the permission popup, from the
// denied tool's name and input. Rule shapes checked against the real CLI
// (2.1.286, `-p`, Windows) on 2026-10-17:
// - "Bash(node *)" allows "node --version"; a compound command is split by the
//   CLI, which then names only the part still needing approval ("...The
//   following part requires approval: git --version").
// - "Bash(<exact command>)" allows that command, quotes and parentheses included.
// - "Edit(...)" also covers Write. An absolute Windows path must be written
//   "//c/Users/..." (drive letter, no colon): the documented "//C:/..." form
//   never matches. A rule for "<dir>/**" doesn't allow writing next to <dir>.
// - "PowerShell(<exact command>)" matches.

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function toRulePath (absolutePath) {
	let path = absolutePath.replace(/\\/g, '/').replace(/\/+$/, '');
	let drive = path.match(/^([A-Za-z]):(\/.*)?$/);
	if (drive) return `//${drive[1].toLowerCase()}${drive[2] ?? ''}`;
	return path.startsWith('/') ? '/' + path : path;
}

function parentDirectory (path) {
	let index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return index > 0 ? path.slice(0, index) : path;
}

// The part of a Bash command the CLI wants approved: the whole command, or the
// one part it names for a compound command.
function bashPartToApprove (command, denialMessage) {
	let named = String(denialMessage ?? '').match(/requires approval:\s*([\s\S]+?)\s*$/);
	return (named ? named[1] : String(command ?? '')).trim();
}

// Returns { once, scoped, whole }:
// - once: rule for exactly the denied action (the bare tool name when no
//   narrower rule can be built);
// - scoped: { rule, kind: 'commands' | 'folder', value } for "always", or null
//   when the tool has no scoped form here (value: the command's first word, or
//   the folder's absolute path);
// - whole: the bare tool name, allowing every use of the tool.
export function buildPermissionChoices (toolName, input, denialMessage) {
	if (toolName === 'Bash' && typeof input?.command === 'string') {
		let part = bashPartToApprove(input.command, denialMessage);
		let firstWord = part.split(/\s+/)[0];
		return {
			once: part && !part.includes('\n') ? `Bash(${part})` : 'Bash',
			scoped: firstWord ? { rule: `Bash(${firstWord} *)`, kind: 'commands', value: firstWord } : null,
			whole: 'Bash',
		};
	}
	if (toolName === 'PowerShell' && typeof input?.command === 'string') {
		let command = input.command.trim();
		return {
			once: command && !command.includes('\n') ? `PowerShell(${command})` : 'PowerShell',
			scoped: null,
			whole: 'PowerShell',
		};
	}
	let path = input?.file_path ?? input?.notebook_path;
	if (EDIT_TOOLS.includes(toolName) && typeof path === 'string') {
		let folder = parentDirectory(path);
		return {
			once: `Edit(${toRulePath(path)})`,
			scoped: { rule: `Edit(${toRulePath(folder)}/**)`, kind: 'folder', value: folder },
			whole: toolName,
		};
	}
	return { once: toolName, scoped: null, whole: toolName };
}
