// Thin wrappers around the server's REST endpoints, which just read and write
// what Claude Code already persists on disk (see doc/plan.md) — no storage of
// our own.

export async function fetchProjects () {
	let response = await fetch('/api/projects');
	return response.json();
}

// The user's own workspace list ({ exists, workspaces, lastWorkspace }) — see
// server/workspaces.js. Saved whole, not entry by entry.
export async function fetchWorkspaceStore () {
	let response = await fetch('/api/workspaces');
	return response.json();
}

export async function saveWorkspaceStore (store) {
	let response = await fetch('/api/workspaces', {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(store),
	});
	return response.ok;
}

export async function fetchHistoryProjects () {
	let response = await fetch('/api/history-projects');
	return response.json();
}

export async function deleteProject (cwd) {
	let response = await fetch(`/api/projects?cwd=${encodeURIComponent(cwd)}`, {
		method: 'DELETE',
	});
	return response.ok;
}

export async function fetchSessions (cwd) {
	let response = await fetch(`/api/sessions?cwd=${encodeURIComponent(cwd)}`);
	return response.json();
}

export async function fetchSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`);
	if (!response.ok) return null;
	return response.json();
}

export async function renameSession (cwd, sessionId, title) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/title?cwd=${encodeURIComponent(cwd)}`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ title }),
	});
	return response.ok;
}

export async function deleteSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(cwd)}`, {
		method: 'DELETE',
	});
	return response.ok;
}

export async function duplicateSession (cwd, sessionId) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/duplicate?cwd=${encodeURIComponent(cwd)}`, {
		method: 'POST',
	});
	if (!response.ok) return null;
	return response.json();
}

export async function moveSession (cwd, sessionId, targetCwd) {
	let response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/move?cwd=${encodeURIComponent(cwd)}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ targetCwd }),
	});
	return response.ok;
}
